/**
 * Self-hosted Chatterbox TTS adapter for the LiveKit voice pipeline.
 *
 * WHY THIS EXISTS (and isn't just a stock openai.TTS like Speaches/Kokoro):
 * the openai.TTS plugin hardcodes `response_format: "pcm"` and feeds the raw
 * response bytes straight into a 24 kHz PCM stream with NO container parsing
 * (see node_modules/@livekit/agents-plugin-openai/dist/tts.js). Chatterbox's
 * OpenAI-compatible `/v1/audio/speech` only supports wav/opus/mp3 — there is no
 * `pcm`. So we request `wav` (which Chatterbox writes as 24 kHz mono pcm_16),
 * strip the RIFF header, and feed just the PCM `data` chunk into AudioByteStream.
 *
 * This is a BATCH (non-streaming) TTS — `super(..., { streaming: false })`. The
 * AgentSession auto-wraps it for per-sentence synthesis, exactly like Speaches,
 * so multi-sentence replies still synthesize sentence-by-sentence with no extra
 * wiring here. Framing (requestId/segmentId/final) mirrors the openai plugin.
 */

import { AudioByteStream, shortuuid, tts } from "@livekit/agents";

// Chatterbox outputs 24 kHz mono. AudioByteStream interprets the bytes we hand it
// as 16-bit PCM at this rate/channel count — which is exactly what the wav `data`
// chunk contains once the header is removed.
const CHATTERBOX_SAMPLE_RATE = 24000;
const CHATTERBOX_CHANNELS = 1;

/**
 * Locate the PCM payload inside a RIFF/WAVE buffer.
 *
 * Walks the WAVE subchunks rather than assuming a fixed 44-byte header, because
 * soundfile (what Chatterbox uses) can emit extra chunks (e.g. LIST/fact) before
 * `data`. Returns the `data` byte range plus the sample rate declared in `fmt `.
 *
 * @param {ArrayBuffer} arrayBuffer - raw response body from /v1/audio/speech.
 * @returns {{ pcm: Uint8Array, sampleRate: number }}
 */
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  // RIFF header: "RIFF" <size> "WAVE", then subchunks start at byte 12.
  if (view.getUint32(0, false) !== 0x52494646 /* "RIFF" */ ||
      view.getUint32(8, false) !== 0x57415645 /* "WAVE" */) {
    throw new Error("Chatterbox response is not a RIFF/WAVE buffer");
  }

  let sampleRate = CHATTERBOX_SAMPLE_RATE;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false); // big-endian compare of the 4 ASCII bytes
    const chunkSize = view.getUint32(offset + 4, true); // little-endian
    const bodyStart = offset + 8;

    if (chunkId === 0x666d7420 /* "fmt " */) {
      // fmt body: audioFormat(2) numChannels(2) sampleRate(4) ...
      sampleRate = view.getUint32(bodyStart + 4, true);
    } else if (chunkId === 0x64617461 /* "data" */) {
      return {
        pcm: new Uint8Array(arrayBuffer, bodyStart, chunkSize),
        sampleRate,
      };
    }

    // Subchunks are word-aligned: a byte of padding follows an odd size.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  throw new Error("Chatterbox WAV had no `data` chunk");
}

/**
 * Batch TTS backed by the self-hosted Chatterbox server's OpenAI-compatible endpoint.
 */
export class ChatterboxTTS extends tts.TTS {
  #opts;
  label = "chatterbox.TTS";

  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    super(CHATTERBOX_SAMPLE_RATE, CHATTERBOX_CHANNELS, { streaming: false });
    this.#opts = {
      baseURL: (env.CHATTERBOX_BASE_URL || "").replace(/\/$/, ""),
      apiKey: env.CHATTERBOX_API_KEY || "chatterbox", // Chatterbox has no auth; any string works
      model: env.CHATTERBOX_TTS_MODEL,
      voice: env.CHATTERBOX_TTS_VOICE,
    };
  }

  get model() {
    return this.#opts.model || "unknown";
  }

  get provider() {
    try {
      return new URL(this.#opts.baseURL).host;
    } catch {
      return "chatterbox";
    }
  }

  /**
   * @param {string} text
   * @param {import("@livekit/agents").APIConnectOptions} [connOptions]
   * @param {AbortSignal} [abortSignal]
   */
  synthesize(text, connOptions, abortSignal) {
    return new ChatterboxChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream() {
    // Chatterbox's /v1/audio/speech is request/response only — no token streaming.
    throw new Error("Streaming is not supported on Chatterbox TTS");
  }
}

/**
 * One synthesis request: POST text -> wav, strip header, emit PCM frames.
 * Mirrors the openai plugin's ChunkedStream framing (one requestId, last frame final).
 */
class ChatterboxChunkedStream extends tts.ChunkedStream {
  label = "chatterbox.ChunkedStream";
  #opts;

  constructor(ttsInstance, text, opts, connOptions, abortSignal) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
  }

  async run() {
    try {
      const res = await fetch(`${this.#opts.baseURL}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#opts.apiKey}`,
        },
        body: JSON.stringify({
          input: this.inputText,
          model: this.#opts.model,
          voice: this.#opts.voice,
          response_format: "wav", // Chatterbox is wav-only; we strip the header below
          speed: 1,
        }),
        signal: this.abortSignal,
      });
      if (!res.ok) {
        throw new Error(`Chatterbox TTS failed: ${res.status} ${await res.text()}`);
      }

      const { pcm } = parseWav(await res.arrayBuffer());

      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(CHATTERBOX_SAMPLE_RATE, CHATTERBOX_CHANNELS);
      const frames = audioByteStream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));

      // Defer emitting each frame so we know which one is last (final: true).
      let lastFrame;
      const sendLastFrame = (final) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
          lastFrame = void 0;
        }
      };
      for (const frame of frames) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (error) {
      // An interrupted turn aborts the fetch — that's expected, not an error.
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    } finally {
      this.queue.close();
    }
  }
}

/**
 * Pre-warm the Chatterbox server before the agent speaks its greeting.
 *
 * The model is resident at server boot, but the FIRST synthesis still pays a
 * ~8.6s CUDA-kernel warmup. The greeting is that first synth, and the pipeline
 * force-closes a turn if the first TTS frame is late (~10s) — so a throwaway
 * request here absorbs the warmup, and the greeting that follows is fast. On an
 * already-warm server it returns quickly, so the per-call cost is negligible.
 *
 * Best-effort: any failure (server down, etc.) is swallowed — the real call
 * still proceeds and just pays the warmup on the greeting instead.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export async function warmChatterboxTts(env) {
  const base = env.CHATTERBOX_BASE_URL?.replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CHATTERBOX_API_KEY || "chatterbox"}`,
      },
      body: JSON.stringify({
        input: "warm up",
        model: env.CHATTERBOX_TTS_MODEL,
        voice: env.CHATTERBOX_TTS_VOICE,
        response_format: "wav",
      }),
    });
  } catch {
    // ignore — warmup on first real synth is the fallback
  }
}
