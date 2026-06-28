/**
 * Voice-pipeline provider factories for the LiveKit agent worker.
 *
 * Selects the STT and TTS implementations from environment variables so each leg
 * can be swapped independently, for A/B-ing latency/quality/cost:
 *
 *   STT_PROVIDER = elevenlabs | speaches | sherpa | sensevoice   (default elevenlabs)
 *   TTS_PROVIDER = elevenlabs | speaches | chatterbox | voxcpm   (default elevenlabs)
 *
 * STT options: ElevenLabs (cloud streaming), Speaches (self-hosted Whisper, BATCH via
 * StreamAdapter), sherpa-onnx (self-hosted STREAMING, in-process — see sherpaStt.mjs), or
 * SenseVoice (self-hosted OFFLINE/batch, in-process — see senseVoiceStt.mjs). There is no
 * sherpa/sensevoice TTS; both are STT-only and the TTS leg is unaffected by them.
 * TTS options: ElevenLabs (cloud), Speaches/Kokoro (self-hosted, OpenAI-compatible),
 * Chatterbox (self-hosted, wav-only OpenAI endpoint — custom client, see chatterboxTts.mjs),
 * or VoxCPM 1.5 (self-hosted nano-vLLM-VoxCPM, raw-PCM /generate — custom client, see voxcpmTts.mjs).
 */

import { stt } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import { SherpaSTT } from "./sherpaStt.mjs";
import { SenseVoiceSTT } from "./senseVoiceStt.mjs";
import { ChatterboxTTS, warmChatterboxTts } from "./chatterboxTts.mjs";
import { VoxcpmTTS, warmVoxcpmTts } from "./voxcpmTts.mjs";

/**
 * Build the STT for this session.
 * @param {NodeJS.ProcessEnv} env - provider switch + Speaches config source.
 * @param {import("@livekit/agents").VAD} vad - shared local VAD used by the
 *        StreamAdapter to endpoint batch transcription (ignored for ElevenLabs).
 */
export function createStt(env, vad) {
  if (env.STT_PROVIDER === "sherpa") {
    // Self-hosted STREAMING STT (in-process sherpa-onnx). It self-endpoints and emits
    // interim transcripts, so the `vad` arg is unused here. See sherpaStt.mjs.
    return new SherpaSTT(env);
  }

  if (env.STT_PROVIDER === "sensevoice") {
    // Self-hosted OFFLINE SenseVoice (in-process sherpa-onnx). Batch like Speaches: wrap in
    // a StreamAdapter so the shared VAD segments utterances and feeds them to _recognize.
    return new stt.StreamAdapter(new SenseVoiceSTT(env), vad);
  }

  if (env.STT_PROVIDER === "speaches") {
    // Batch whisper via Speaches' OpenAI-compatible /v1/audio/transcriptions,
    // wrapped so AgentSession can consume it as a streaming STT.
    const batch = new openai.STT({
      baseURL: env.SPEACHES_BASE_URL,
      apiKey: env.SPEACHES_API_KEY || "speaches", // Speaches auth is off by default; any non-empty string works
      model: env.SPEACHES_STT_MODEL,
      useRealtime: false, // force batch HTTP; realtime WS isn't Speaches-compatible
      // openai.STT defaults language to "en"; set SPEACHES_STT_LANGUAGE to force another.
      ...(env.SPEACHES_STT_LANGUAGE ? { language: env.SPEACHES_STT_LANGUAGE } : {}),
    });
    return new stt.StreamAdapter(batch, vad);
  }

  // Default: ElevenLabs Scribe v2 realtime (own key), unchanged from before.
  return new elevenlabs.STT({
    apiKey: env.ELEVENLABS_API_KEY,
    modelId: "scribe_v2_realtime",
    serverVad: { vadSilenceThresholdSecs: 0.6 },
  });
}

/**
 * Build the TTS for this session.
 * @param {NodeJS.ProcessEnv} env - provider switch + Speaches config source.
 */
export function createTts(env) {
  if (env.TTS_PROVIDER === "chatterbox") {
    // Self-hosted Chatterbox via its OpenAI-compatible /v1/audio/speech. The stock openai.TTS
    // can't be used (it forces response_format:"pcm"; Chatterbox is wav-only) — see chatterboxTts.mjs.
    return new ChatterboxTTS(env);
  }

  if (env.TTS_PROVIDER === "voxcpm") {
    // Self-hosted VoxCPM 1.5 via nano-vLLM-VoxCPM's /generate (non-OpenAI; we use our raw-PCM
    // fork mode and a fixed reference-clone voice) — custom client, see voxcpmTts.mjs.
    return new VoxcpmTTS(env);
  }

  if (env.TTS_PROVIDER === "speaches") {
    // Non-streaming Kokoro via Speaches' /v1/audio/speech (24 kHz mono PCM).
    // Passed as-is; the framework auto-wraps it for per-sentence streaming. See the
    // module header for why we must NOT pre-wrap it in tts.StreamAdapter ourselves.
    return new openai.TTS({
      baseURL: env.SPEACHES_BASE_URL,
      apiKey: env.SPEACHES_API_KEY || "speaches",
      model: env.SPEACHES_TTS_MODEL,
      voice: env.SPEACHES_TTS_VOICE,
    });
  }

  // Default: ElevenLabs multilingual TTS (own key), unchanged from before.
  return new elevenlabs.TTS({
    apiKey: env.ELEVENLABS_API_KEY,
    voiceId: env.ELEVENLABS_VOICE_ID,
    model: "eleven_multilingual_v2",
  });
}

// Chatterbox's and VoxCPM's pre-greeting warm-ups live in their own client modules;
// re-export them here so agent.mjs imports every warm-up helper from this one module.
export { warmChatterboxTts };
export { warmVoxcpmTts };

/**
 * Pre-load the Speaches TTS model before the agent speaks its greeting.
 *
 * Kokoro cold-loads in ~6s. The greeting fires the instant the call connects, and
 * the voice pipeline force-closes a turn if the first TTS frame doesn't arrive
 * within ~10s — so on a cold model the very first greeting comes out silent. A
 * direct one-shot request here loads the model up front (this call has no
 * first-frame timeout), so the greeting that follows synthesizes fast. On an
 * already-warm model it returns in ~tens of ms, so the per-call cost is negligible.
 *
 * Best-effort: any failure (Speaches down, etc.) is swallowed — the real call still
 * proceeds and the model just loads lazily on first use, exactly as before.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export async function warmSpeachesTts(env) {
  const base = env.SPEACHES_BASE_URL?.replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.SPEACHES_API_KEY || "speaches"}`,
      },
      body: JSON.stringify({
        input: "warm up",
        model: env.SPEACHES_TTS_MODEL,
        voice: env.SPEACHES_TTS_VOICE,
        response_format: "pcm",
      }),
    });
  } catch {
    // ignore — lazy load on first real synth is the fallback
  }
}
