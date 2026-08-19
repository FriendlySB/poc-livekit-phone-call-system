/**
 * Voice-pipeline provider factories for the LiveKit agent worker.
 *
 * Selects the STT and TTS implementations from environment variables so each leg
 * can be swapped independently, for A/B-ing latency/quality/cost:
 *
 *   STT_PROVIDER = elevenlabs | speaches | sherpa | sensevoice   (default elevenlabs)
 *   TTS_PROVIDER = elevenlabs | speaches | chatterbox | voxcpm | pocket | vibevoice
 *                                                                        (default elevenlabs)
 *
 * STT options: ElevenLabs (cloud streaming), Speaches (self-hosted Whisper, BATCH via
 * StreamAdapter), sherpa-onnx (self-hosted STREAMING, in-process — see sherpaStt.mjs), or
 * SenseVoice (self-hosted OFFLINE/batch, in-process — see senseVoiceStt.mjs). There is no
 * sherpa/sensevoice TTS; both are STT-only and the TTS leg is unaffected by them.
 * TTS options: ElevenLabs (cloud), Speaches/Kokoro (self-hosted, OpenAI-compatible),
 * Chatterbox (self-hosted, wav-only OpenAI endpoint — custom client, see chatterboxTts.mjs),
 * VoxCPM 1.5 (self-hosted nano-vLLM-VoxCPM, raw-PCM /generate — custom client, see voxcpmTts.mjs),
 * Pocket TTS (self-hosted Kyutai 100M CPU model behind its community OpenAI-compatible
 * server — 24 kHz PCM, so it reuses the stock openai.TTS path like Speaches; no custom client),
 * or VibeVoice-Realtime (self-hosted Microsoft 0.5B GPU model behind our own thin OpenAI shim,
 * VibeVoice/demo/openai_server.py — also 24 kHz PCM, so likewise no custom client).
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

  if (env.TTS_PROVIDER === "pocket") {
    // Self-hosted Kyutai Pocket TTS behind its community OpenAI-compatible server
    // (POST /v1/audio/speech). It serves 24 kHz mono PCM — the exact shape the stock
    // openai.TTS plugin expects — so, unlike Chatterbox/VoxCPM, no custom client is needed.
    // Runs on CPU, freeing the GPU for STT. Passed as-is (framework auto-wraps per-sentence).
    return new openai.TTS({
      baseURL: env.POCKET_BASE_URL,
      apiKey: env.POCKET_API_KEY || "pocket", // server needs no auth; any non-empty string works
      model: env.POCKET_TTS_MODEL || "pocket-tts", // ignored server-side
      voice: env.POCKET_TTS_VOICE, // built-in voice name (e.g. "alba") or a cloned-voice filename
    });
  }

  if (env.TTS_PROVIDER === "vibevoice") {
    // Self-hosted VibeVoice-Realtime-0.5B (Microsoft) behind our own thin OpenAI shim
    // (VibeVoice/demo/openai_server.py), which wraps the model's native 24 kHz mono PCM in
    // POST /v1/audio/speech — so the stock openai.TTS plugin drives it directly, no custom
    // client. Voice is a fixed preset name (no cloning); see the README for the list.
    return new openai.TTS({
      baseURL: env.VIBEVOICE_BASE_URL,
      apiKey: env.VIBEVOICE_API_KEY || "vibevoice", // shim has no auth; any non-empty string works
      model: env.VIBEVOICE_TTS_MODEL || "vibevoice-realtime", // ignored server-side
      voice: env.VIBEVOICE_TTS_VOICE, // preset stem, e.g. "en-Emma_woman"
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

/**
 * Pre-load the Pocket TTS model before the agent speaks its greeting.
 *
 * Same rationale as warmSpeachesTts: the community Pocket server cold-loads the model on
 * its first request, which can exceed the voice pipeline's ~10s first-frame timeout and
 * silence the greeting. A one-shot request here loads it up front (no timeout on this
 * call); a warm server returns in ~tens of ms, so the per-call cost is negligible.
 *
 * Best-effort: any failure (server down, etc.) is swallowed — the call still proceeds and
 * the model loads lazily on first real synth.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export async function warmPocketTts(env) {
  const base = env.POCKET_BASE_URL?.replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.POCKET_API_KEY || "pocket"}`,
      },
      body: JSON.stringify({
        input: "warm up",
        model: env.POCKET_TTS_MODEL || "pocket-tts",
        voice: env.POCKET_TTS_VOICE,
        response_format: "pcm",
      }),
    });
  } catch {
    // ignore — lazy load on first real synth is the fallback
  }
}

/**
 * Pre-warm VibeVoice before the agent speaks its greeting.
 *
 * The shim loads the model at boot, so this isn't a model-load wait like Speaches —
 * it's the first CUDA/diffusion pass, which pays kernel warmup (same reason Chatterbox
 * and VoxCPM need one). Doing it here keeps that cost off the greeting, which the
 * pipeline would otherwise cut off on its first-frame timeout.
 *
 * Best-effort: any failure (shim down, etc.) is swallowed — the call still proceeds.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export async function warmVibevoiceTts(env) {
  const base = env.VIBEVOICE_BASE_URL?.replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.VIBEVOICE_API_KEY || "vibevoice"}`,
      },
      body: JSON.stringify({
        // VibeVoice is documented as unstable on inputs of three words or fewer, so the
        // warm-up line is deliberately longer than the other providers' "warm up".
        input: "Warming up the speech model.",
        model: env.VIBEVOICE_TTS_MODEL || "vibevoice-realtime",
        voice: env.VIBEVOICE_TTS_VOICE,
        response_format: "pcm",
      }),
    });
  } catch {
    // ignore — lazy warmup on first real synth is the fallback
  }
}
