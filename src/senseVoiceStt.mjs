/**
 * Self-hosted OFFLINE (batch) STT for the LiveKit agent, via sherpa-onnx SenseVoice.
 *
 * This is a NON-streaming recognizer — the counterpart to the Speaches/Whisper path, not
 * the streaming sherpa-onnx zipformer (sherpaStt.mjs). SenseVoice does a single
 * non-autoregressive forward pass per utterance (no token-by-token LLM decoding), so it's
 * fast on CPU while keeping good multilingual accuracy. We pin it to English. The point of
 * this provider is to A/B a self-hosted, in-process batch STT against Whisper for
 * speed+accuracy, without a separate server/Docker/WebSocket.
 *
 * Because it's batch (no interim transcripts), it plugs in exactly like Speaches: wrapped in
 * `stt.StreamAdapter` + the shared VAD, which buffers each VAD-segmented utterance and then
 * calls our `_recognize()`. Turn-taking therefore uses the VAD path in agent.mjs (no semantic
 * turn detector, no PREFLIGHT — those belong to the streaming providers).
 *
 * To plug into agents-js we implement the framework's offline-STT contract (verified against
 * stt/stt.d.ts): subclass abstract `stt.STT` with `super({streaming:false, interimResults:false})`
 * and implement `_recognize(buffer)`; `stream()` is unused (StreamAdapter supplies streaming).
 *
 * Audio: the StreamAdapter hands `_recognize` the buffered utterance at the telephony rate
 * (8 kHz). We `mergeFrames` it to one AudioFrame, convert Int16 -> Float32 [-1,1], and pass
 * the native sample rate to sherpa's `acceptWaveform`, which RESAMPLES internally to the
 * model's 16 kHz (no extra resampler needed, same as the smoke test shows).
 *
 * The OfflineRecognizer loads the ~930 MB model once per worker process (getOfflineRecognizer
 * memoizes); agent.mjs preloads it in prewarm so the cost isn't paid on the first caller turn.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { stt, mergeFrames } from "@livekit/agents";
// sherpa-onnx-node is CommonJS; default import gives module.exports (OfflineRecognizer, ...).
import sherpa from "sherpa-onnx-node";
// Reuse the pure Int16->Float32 helper already unit-tested in the streaming module.
import { int16ToFloat32 } from "./sherpaStt.mjs";

const { STT, SpeechEventType } = stt;

// One offline recognizer per worker process (model load is heavy ~930 MB fp32; the recognizer
// is reused across calls — each call gets a lightweight stream via createStream()).
let recognizer = null;

/**
 * Resolve the SenseVoice model + tokens from env and build (once) the OfflineRecognizer.
 * Paths resolve from the worker CWD (project root) unless absolute. Fails fast with a clear
 * message if a file is missing, so a misconfigured dir doesn't surface as an opaque native crash.
 * @param {NodeJS.ProcessEnv} env
 */
export function getOfflineRecognizer(env) {
  if (recognizer) return recognizer;

  const dir = resolve(
    env.SENSEVOICE_MODEL_DIR || "./models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09",
  );
  const files = {
    model: join(dir, env.SENSEVOICE_MODEL || "model.onnx"),
    tokens: join(dir, env.SENSEVOICE_TOKENS || "tokens.txt"),
  };
  for (const [name, p] of Object.entries(files)) {
    if (!existsSync(p)) {
      throw new Error(
        `SenseVoice STT: ${name} not found at ${p}. Download the model into ${dir} (see README).`,
      );
    }
  }

  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: files.model,
        // Pin the language so it never drifts (codes: auto|zh|en|ja|ko|yue). "en" by default.
        language: env.SENSEVOICE_LANGUAGE || "en",
        // Inverse text normalization (spoken -> written, e.g. "twenty" -> "20"). 1 = on.
        useInverseTextNormalization: Number(env.SENSEVOICE_USE_ITN ?? 1),
      },
      tokens: files.tokens,
      numThreads: Number(env.SENSEVOICE_NUM_THREADS || 2),
      provider: "cpu", // non-autoregressive single pass; CPU is fine, no GPU needed
      debug: 0,
    },
  });
  return recognizer;
}

/** @internal Reset the memoized recognizer (tests only). */
export function _resetOfflineRecognizer() {
  recognizer = null;
}

/**
 * Offline/batch STT backed by a shared sherpa-onnx OfflineRecognizer (SenseVoice).
 * Must be wrapped in `stt.StreamAdapter` by the caller (see agentProviders.mjs).
 */
export class SenseVoiceSTT extends STT {
  #env;
  label = "sherpa-onnx.SenseVoiceSTT";

  constructor(env) {
    // Batch: no streaming, no interim results — the StreamAdapter + VAD supply segmentation.
    super({ streaming: false, interimResults: false });
    this.#env = env;
  }

  get model() {
    return this.#env.SENSEVOICE_MODEL_DIR || "sherpa-onnx-sense-voice";
  }

  get provider() {
    return "sherpa-onnx-sensevoice";
  }

  /** Load the model now (called from agent.mjs prewarm so the first call isn't cold). */
  prewarm() {
    getOfflineRecognizer(this.#env);
  }

  /**
   * Transcribe one VAD-segmented utterance. The StreamAdapter buffers frames and calls this.
   * @param {import("@livekit/agents").AudioBuffer} buffer
   * @returns {Promise<import("@livekit/agents").stt.SpeechEvent>}
   */
  async _recognize(buffer) {
    const frame = mergeFrames(buffer); // AudioBuffer (AudioFrame[]|AudioFrame) -> one AudioFrame
    const rec = getOfflineRecognizer(this.#env);
    const s = rec.createStream();
    // Pass the native rate (8 kHz telephony); sherpa resamples to the model's 16 kHz internally.
    s.acceptWaveform({ sampleRate: frame.sampleRate, samples: int16ToFloat32(frame.data) });
    rec.decode(s); // single non-autoregressive pass — fast enough to run synchronously
    const text = rec.getResult(s).text.trim();

    return {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          language: this.#env.SENSEVOICE_LANGUAGE || "en",
          text,
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    };
  }

  // Streaming is provided by the StreamAdapter wrapper, not this class.
  stream() {
    throw new Error("SenseVoiceSTT is batch-only; wrap it in stt.StreamAdapter");
  }
}
