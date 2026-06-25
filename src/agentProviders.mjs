/**
 * Voice-pipeline provider factories for the LiveKit agent worker.
 *
 * Selects the STT and TTS implementations from environment variables so each leg
 * can be swapped between ElevenLabs (cloud, default) and a self-hosted Speaches
 * box (OpenAI-compatible) independently, for A/B-ing latency/quality/cost:
 *
 *   STT_PROVIDER = elevenlabs | speaches   (default elevenlabs)
 *   TTS_PROVIDER = elevenlabs | speaches   (default elevenlabs)
 *
 */

import { stt } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";

/**
 * Build the STT for this session.
 * @param {NodeJS.ProcessEnv} env - provider switch + Speaches config source.
 * @param {import("@livekit/agents").VAD} vad - shared local VAD used by the
 *        StreamAdapter to endpoint batch transcription (ignored for ElevenLabs).
 */
export function createStt(env, vad) {
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
