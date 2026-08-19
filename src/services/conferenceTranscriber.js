/**
 * Transcriber for the caller <-> human-agent conference, selectable per deployment.
 *
 * WHY ONE IMPLEMENTATION AND NOT TWO
 * ----------------------------------
 * Speaches exposes a realtime WebSocket that speaks the SAME OpenAI Realtime protocol
 * (https://speaches.ai/usage/realtime-api/), including `session.update`,
 * `input_audio_buffer.append` and `conversation.item.input_audio_transcription.completed`.
 * So switching providers is a matter of URL, auth and audio encoding — the socket
 * lifecycle and the transcript handling below are shared.
 *
 * It also means server-side VAD comes along for free (Speaches emits
 * input_audio_buffer.speech_started/speech_stopped). That is the reason to use the
 * realtime endpoint rather than the batch /v1/audio/transcriptions one, which would have
 * forced a VAD implementation into Express just to find utterance boundaries.
 *
 * PROVIDERS
 *   openai   (default) - wss://api.openai.com/v1/realtime, cloud, gpt-4o-transcribe
 *   speaches           - local turbo Whisper, ?intent=transcription
 *
 * The default is `openai` so the two existing conference paths (OpenAI Realtime and the
 * ElevenLabs human transfer) behave exactly as before unless explicitly switched.
 */

const WebSocket = require("ws");
const { twilioMediaToPcm } = require("../audioCodec");

/**
 * Resolve the provider for this session.
 * ServeAI config wins over env, mirroring how liveKitSTT overrides STT_PROVIDER.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [configured] - optional ServeAI `conferenceSTT`
 */
function resolveProvider(env, configured) {
  return (configured || env.CONFERENCE_STT_PROVIDER || "openai").toLowerCase();
}

/** http(s):// -> ws(s)://, so SPEACHES_BASE_URL can be reused verbatim. */
function toWsUrl(httpUrl) {
  return String(httpUrl).replace(/^http/, "ws").replace(/\/$/, "");
}

/**
 * 8 kHz -> 24 kHz by 3x linear interpolation.
 *
 * Twilio's telephone audio is 8 kHz. Speaches' realtime endpoint requires 24 kHz, and the
 * rate is NOT negotiable — it is hardcoded on both sides of the decode in
 * speaches/realtime/input_audio_buffer_event_router.py:
 *
 *     audio_chunk = audio_samples_from_file(...)          # sf.read RAW @ 24000
 *     audio_chunk = resample_audio_data(audio_chunk, 24000, 16000)
 *
 * i.e. the server reads the raw bytes as 24 kHz and then resamples them to the 16 kHz its
 * VAD and Whisper actually run at. Do not be misled by `sf.write(..., samplerate=16000)`
 * in input_audio_buffer.py — that writes the ALREADY-resampled buffer and says nothing
 * about the wire format.
 *
 * Getting this wrong does not fail loudly. Send 16 kHz and the server scales it by 2/3,
 * so the speech plays back 1.5x too fast: VAD still fires, transcripts still arrive, and
 * they are confident nonsense — a 3.6 s sentence came back as "Thank you.", Whisper's
 * standard output for unintelligible audio.
 *
 * Linear interpolation rather than sample-and-hold: the latter's stair-stepping adds
 * high-frequency artefacts, and this audio is narrowband enough already.
 *
 * @param {Int16Array} int16
 * @returns {Int16Array}
 */
function upsample3x(int16) {
  const out = new Int16Array(int16.length * 3);
  for (let i = 0; i < int16.length; i++) {
    const a = int16[i];
    const b = i + 1 < int16.length ? int16[i + 1] : a;
    out[i * 3] = a;
    out[i * 3 + 1] = Math.round(a + (b - a) / 3);
    out[i * 3 + 2] = Math.round(a + ((b - a) * 2) / 3);
  }
  return out;
}

/**
 * Build the connection + session config for a provider.
 * Kept separate from the socket so tests can assert the URL/auth/session without a network.
 *
 * @param {string} provider
 * @param {NodeJS.ProcessEnv} env
 * @returns {{url:string, headers:object, session:object, encode:(payload:string)=>string}}
 */
function buildProviderConfig(provider, env) {
  const language = env.CONFERENCE_STT_LANGUAGE || "en";

  if (provider === "speaches") {
    const base = toWsUrl(env.SPEACHES_BASE_URL || "http://localhost:8000/v1");
    const model =
      env.SPEACHES_CONFERENCE_MODEL || "deepdml/faster-whisper-large-v3-turbo-ct2";

    return {
      url: `${base}/realtime?model=${encodeURIComponent(model)}&intent=transcription`,
      headers: { Authorization: `Bearer ${env.SPEACHES_API_KEY || "speaches"}` },
      // Flat schema (the original OpenAI Realtime shape), which is what Speaches
      // implements — not the newer nested audio.input.* form used on the openai branch.
      session: {
        type: "session.update",
        session: {
          // input_audio_format is deliberately omitted: Speaches answers
          // "Specifying `session.input_audio_format` is not supported" and drops the
          // field. The format is fixed at pcm16 @ 24 kHz, which `encode` below produces.
          input_audio_transcription: { model, language },
          // create_response:false is the load-bearing field, and the ONLY reason this
          // block exists. Speaches defaults it to true, so after every completed
          // transcript it tries to generate a chat reply
          // (conversation_event_router.py:133 `await ctx.response.task`). There is no
          // chat LLM behind this deployment, so that raises InternalServerError inside
          // the session TaskGroup and tears the whole socket down — one transcript, then
          // the connection dies. `?intent=transcription` in the URL does not prevent it.
          //
          // The other three fields are only here because Speaches' TurnDetection model
          // requires all four; they are set to the server's own defaults so VAD behaviour
          // is unchanged. prefix_padding_ms cannot be omitted for the same reason, yet
          // sending it always draws an "unsupported field" error event — the server
          // excludes it and applies the rest regardless. That one benign error is
          // filtered below so it cannot be mistaken for a real failure.
          turn_detection: {
            type: "server_vad",
            create_response: false,
            threshold: 0.9,
            prefix_padding_ms: 0,
            silence_duration_ms: 550,
          },
        },
      },
      // Twilio sends 8 kHz mu-law; the server wants 24 kHz PCM16 and nothing else, so
      // both the decode and the resample are mandatory.
      encode: (payload) => {
        const pcm24k = upsample3x(twilioMediaToPcm(payload));
        return Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.length * 2).toString("base64");
      },
    };
  }

  // Default: OpenAI cloud. Session block is a verbatim lift of the previous
  // twilioStreamService.createRealtimeTranscriber config, except `language` is no longer
  // hardcoded to "en".
  const model = env.CONFERENCE_OPENAI_MODEL || "gpt-realtime-mini";
  return {
    url: `wss://api.openai.com/v1/realtime?model=${model}`,
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    session: {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        output_modalities: ["text"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            transcription: {
              model: env.CONFERENCE_OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe",
              prompt:
                "Transcribe the following audio message. Ensure that you transcribe in the exact same language as spoken in the audio. Do not translate or interpret the content, just provide a verbatim transcription.",
              language,
            },
          },
        },
      },
    },
    // Twilio already hands us base64 mu-law, which is what audio/pcmu expects.
    encode: (payload) => payload,
  };
}

/**
 * Open a transcription session for one conference leg.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.provider]        - ServeAI `conferenceSTT` override
 * @param {string} opts.participantType   - "caller" | "human-agent"
 * @param {(messageType:string, transcript:string)=>void} opts.onTranscript
 * @param {Function} [opts.WebSocketImpl] - injectable for tests
 * @returns {{push:(payload:string)=>void, close:()=>void, provider:string, url:string}}
 */
function createConferenceTranscriber({
  env = process.env,
  provider: configuredProvider,
  participantType,
  onTranscript,
  WebSocketImpl = WebSocket,
}) {
  const provider = resolveProvider(env, configuredProvider);
  const { url, headers, session, encode } = buildProviderConfig(provider, env);

  const ws = new WebSocketImpl(url, { headers });

  ws.on("open", () => {
    console.log(`[${provider}] transcription socket open for ${participantType}`);
    ws.send(JSON.stringify(session));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Surface server-side rejections. Without this the socket connects, the audio
      // flows, and nothing whatsoever comes back — which is exactly how a rejected
      // session.update went unnoticed until the server's own logs were read.
      if (msg.type === "error") {
        // Expected and harmless: Speaches requires prefix_padding_ms in a turn_detection
        // update but rejects the value. See the session config above.
        if (!/prefix_padding_ms/.test(msg.error?.message || "")) {
          console.error(`[${provider}] server error for ${participantType}:`, msg.error?.message);
        }
        return;
      }
      if (msg.type !== "conversation.item.input_audio_transcription.completed") return;

      const transcript = msg.transcript;
      if (!transcript || !transcript.trim()) return;

      const messageType = participantType === "caller" ? "user" : "humanAgent";
      console.log(`${participantType === "caller" ? "Caller" : "Human Agent"} said: ${transcript}`);
      onTranscript?.(messageType, transcript);
    } catch (e) {
      console.error(`[${provider}] error processing transcription message:`, e.message);
    }
  });

  ws.on("close", () => console.log(`[${provider}] transcription socket closed for ${participantType}`));
  ws.on("error", (err) => console.error(`[${provider}] transcription socket error for ${participantType}:`, err));

  return {
    provider,
    url,
    push(payload) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: encode(payload) }));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

module.exports = { createConferenceTranscriber, buildProviderConfig, resolveProvider, toWsUrl };
