/**
 * Self-hosted STREAMING STT for the LiveKit agent, via sherpa-onnx (k2-fsa).
 *
 * Unlike the Speaches/Whisper path (batch — buffer the whole utterance, then transcribe,
 * no interim results), sherpa-onnx is a true streaming recognizer: it processes audio
 * chunk-by-chunk and emits partial transcripts as the caller speaks. That removes the
 * post-speech batch wait AND gives the AgentSession interim transcripts to feed its
 * semantic turn detector (so this provider uses the ElevenLabs-style turn-taking in
 * agent.mjs, not VAD-only).
 *
 * It also emits PREFLIGHT_TRANSCRIPT once the transcript stabilises (caller paused), which
 * the session uses to SPECULATIVELY start the LLM during the end-of-turn silence — hiding
 * the LLM's time-to-first-token so the reply is ready when the turn commits. This is the
 * real turnaround win of streaming STT (batch Whisper can't do it). See run() for details.
 *
 * Two streaming model families are supported via SHERPA_STT_MODEL_TYPE: "transducer"
 * (zipformer, English-specialised — the default) and "paraformer" (FunASR bilingual zh-en,
 * which has encoder+decoder but no joiner). buildRecognizerOptions() handles the structural
 * difference; the run() loop below is identical for both.
 *
 * It runs fully IN-PROCESS through the `sherpa-onnx-node` native addon — no server, no
 * WebSocket, no Docker. CPU is plenty (RTF ~0.06 zipformer). To plug it into agents-js we implement
 * the framework's two abstract classes (verified against stt/stt.d.ts):
 *   - `stt.STT`         -> SherpaSTT          (capabilities + factory for the stream)
 *   - `stt.SpeechStream`-> SherpaSpeechStream (the per-call decode loop)
 *
 * Audio handling: AgentSession pushes mono Int16 `AudioFrame`s at the telephony rate
 * (8 kHz). We pass `sampleRate: 16000` to the SpeechStream base, whose `pushFrame`
 * auto-resamples to 16 kHz (the model's rate) before frames reach `this.input` — so here
 * we only convert Int16 -> Float32 [-1,1], which is what sherpa's acceptWaveform expects.
 *
 * The OnlineRecognizer loads the model once per worker process (getRecognizer memoizes);
 * agent.mjs calls prewarm() so that cost is paid before the first call, not during it.
 */

import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { stt } from "@livekit/agents";
// sherpa-onnx-node is CommonJS; default import gives its module.exports (OnlineRecognizer, ...).
import sherpa from "sherpa-onnx-node";

const { STT, SpeechStream, SpeechEventType } = stt;

/**
 * Convert an Int16 PCM frame (AudioFrame.data) to Float32 in [-1, 1] for acceptWaveform.
 * Pure + offline — unit tested.
 * @param {Int16Array} int16
 * @returns {Float32Array}
 */
export function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = int16[i] / 32768;
  }
  return out;
}

// One recognizer per worker process (model load is heavy; the recognizer itself is
// stateless across calls — each call gets its own lightweight stream via createStream()).
let recognizer = null;

/**
 * Resolve model files from env and build the OnlineRecognizer options object.
 *
 * Supports two streaming model families via SHERPA_STT_MODEL_TYPE:
 *   - "transducer" (default): zipformer — encoder + decoder + joiner. English-specialised
 *     (the 2023-06-21 LibriSpeech+GigaSpeech model).
 *   - "paraformer": Alibaba/FunASR streaming paraformer — encoder + decoder, NO joiner.
 *     These are bilingual zh-en (or trilingual). The recognizer config key differs
 *     (`modelConfig.paraformer` vs `modelConfig.transducer`), hence the branch.
 *
 * Default filenames are type-aware, so switching models only needs MODEL_TYPE + MODEL_DIR
 * (each `SHERPA_STT_ENCODER/DECODER/JOINER/TOKENS` still overrides individually). Paths
 * resolve from the worker CWD (project root) unless absolute, and we fail fast with a clear
 * message if a file is missing — a misconfigured dir shouldn't surface as an opaque native
 * crash mid-call. Shared by getRecognizer() and the smoke test so the two never drift.
 * @param {NodeJS.ProcessEnv} env
 */
export function buildRecognizerOptions(env) {
  const modelType = (env.SHERPA_STT_MODEL_TYPE || "transducer").toLowerCase();
  const isParaformer = modelType === "paraformer";

  const dir = resolve(
    env.SHERPA_STT_MODEL_DIR || "./models/sherpa-onnx-streaming-zipformer-en-2023-06-21",
  );

  // Type-aware default filenames (paraformer ships encoder/decoder.int8.onnx; zipformer
  // ships the epoch-99 transducer trio). int8 is the smaller/faster default for both.
  const defaults = isParaformer
    ? { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", tokens: "tokens.txt" }
    : {
        encoder: "encoder-epoch-99-avg-1.int8.onnx",
        decoder: "decoder-epoch-99-avg-1.onnx",
        joiner: "joiner-epoch-99-avg-1.int8.onnx",
        tokens: "tokens.txt",
      };

  const files = {
    encoder: join(dir, env.SHERPA_STT_ENCODER || defaults.encoder),
    decoder: join(dir, env.SHERPA_STT_DECODER || defaults.decoder),
    tokens: join(dir, env.SHERPA_STT_TOKENS || defaults.tokens),
  };
  if (!isParaformer) files.joiner = join(dir, env.SHERPA_STT_JOINER || defaults.joiner);

  for (const [name, p] of Object.entries(files)) {
    if (!existsSync(p)) {
      throw new Error(
        `sherpa STT: ${name} not found at ${p}. Download/extract the ${modelType} model into ${dir} (see README).`,
      );
    }
  }

  // Paraformer has no joiner; transducer (zipformer) does. Everything else is shared.
  const modelFamily = isParaformer
    ? { paraformer: { encoder: files.encoder, decoder: files.decoder } }
    : { transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner } };

  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...modelFamily,
      tokens: files.tokens,
      numThreads: Number(env.SHERPA_STT_NUM_THREADS || 2),
      provider: "cpu", // CPU is real-time here (RTF ~0.06 for zipformer; heavier for paraformer but still <1)
      debug: 0,
    },
    // sherpa does its own endpoint detection (segments utterances + drives reset()).
    // rule2 = trailing silence AFTER speech before a FINAL fires (= the LLM reply trigger).
    // Lowering it to chase latency BACKFIRES: a natural mid-sentence pause endpoints early, so
    // "oh yeah <pause> is this a restaurant" splits into two turns and the agent replies to the
    // fragment. So keep the library default 1.2s for clean turn grouping; the PREFLIGHT path
    // (see run()) is what actually hides the turnaround latency. Env-tunable if needed.
    enableEndpoint: true,
    rule1MinTrailingSilence: Number(env.SHERPA_STT_RULE1_SILENCE || 2.4), // silence end when nothing decoded
    rule2MinTrailingSilence: Number(env.SHERPA_STT_RULE2_SILENCE || 1.2), // trailing silence after speech
    rule3MinUtteranceLength: Number(env.SHERPA_STT_RULE3_FRAMES || 20), // min frames before an endpoint
  };
}

/**
 * Build (once) the streaming OnlineRecognizer for this worker process.
 * @param {NodeJS.ProcessEnv} env
 */
export function getRecognizer(env) {
  if (recognizer) return recognizer;
  recognizer = new sherpa.OnlineRecognizer(buildRecognizerOptions(env));
  return recognizer;
}

/** @internal Reset the memoized recognizer (tests only). */
export function _resetRecognizer() {
  recognizer = null;
}

/**
 * Streaming STT backed by a shared sherpa-onnx OnlineRecognizer.
 */
export class SherpaSTT extends STT {
  #env;
  label = "sherpa-onnx.STT";

  constructor(env) {
    // Streaming with interim results — this is the whole point vs the Speaches batch path.
    super({ streaming: true, interimResults: true });
    this.#env = env;
  }

  get model() {
    return this.#env.SHERPA_STT_MODEL_DIR || "sherpa-onnx-streaming-zipformer";
  }

  get provider() {
    return "sherpa-onnx";
  }

  /** Load the model now (called from agent.mjs prewarm so the first call isn't cold). */
  prewarm() {
    getRecognizer(this.#env);
  }

  // Streaming-only: the session uses stream() because capabilities.streaming is true.
  async _recognize() {
    throw new Error("SherpaSTT is streaming-only; use stream()");
  }

  stream(options) {
    return new SherpaSpeechStream(this, this.#env, options?.connOptions);
  }
}

/**
 * Per-call decode loop. Reads resampled 16 kHz frames from `this.input`, feeds sherpa
 * chunk-by-chunk, and emits START/INTERIM/FINAL/END speech events on `this.output`.
 */
export class SherpaSpeechStream extends SpeechStream {
  #env;
  label = "sherpa-onnx.SpeechStream";

  constructor(stt, env, connOptions) {
    // 16000 -> base pushFrame resamples incoming 8 kHz telephony frames to the model rate.
    super(stt, 16000, connOptions);
    this.#env = env;
  }

  #speechData(text) {
    return {
      language: this.#env.SHERPA_STT_LANGUAGE || "en",
      text,
      startTime: 0,
      endTime: 0,
      confidence: 1,
    };
  }

  async run() {
    const rec = getRecognizer(this.#env);
    const s = rec.createStream();
    let started = false; // emitted START_OF_SPEECH for the current utterance
    let lastText = ""; // last transcript we emitted an INTERIM for
    let lastChangeAt = 0; // when the transcript last grew (for preflight debounce)
    let preflighted = false; // emitted a PREFLIGHT for the current stable text

    // Once the transcript has been stable for this long, the caller has likely paused at
    // the end of a thought. We emit a PREFLIGHT_TRANSCRIPT, which the session uses to
    // SPECULATIVELY start the LLM during the endpoint-silence window — hiding the LLM's
    // time-to-first-token behind the rule2 wait so the reply is ready when the turn
    // commits. It does NOT commit the turn (FINAL still does), so it never makes the agent
    // talk over the caller. Cost: if the caller resumes, that speculative LLM call is
    // discarded (the framework caps retries). Set to 0 to disable. Streaming-only win —
    // batch STT (Whisper) can't do this.
    const preflightMs = Number(this.#env.SHERPA_STT_PREFLIGHT_MS ?? 300);

    for await (const input of this.input) {
      // FLUSH is a no-op: sherpa segments utterances itself via endpoint detection.
      if (input === SpeechStream.FLUSH_SENTINEL) continue;
      if (input.samplesPerChannel === 0) continue;

      s.acceptWaveform({ sampleRate: this.neededSampleRate, samples: int16ToFloat32(input.data) });
      while (rec.isReady(s)) rec.decode(s);

      const text = rec.getResult(s).text.trim();
      if (text) {
        if (!started) {
          started = true;
          this.output.put({ type: SpeechEventType.START_OF_SPEECH });
        }
        if (text !== lastText) {
          // Transcript still growing: emit interim and reset the stability timer.
          lastText = text;
          lastChangeAt = Date.now();
          preflighted = false;
          this.output.put({
            type: SpeechEventType.INTERIM_TRANSCRIPT,
            alternatives: [this.#speechData(text)],
          });
        } else if (preflightMs > 0 && !preflighted && Date.now() - lastChangeAt >= preflightMs) {
          // Transcript held steady through the debounce → speculatively pre-start the LLM.
          preflighted = true;
          this.output.put({
            type: SpeechEventType.PREFLIGHT_TRANSCRIPT,
            alternatives: [this.#speechData(text)],
          });
        }
      }

      if (rec.isEndpoint(s)) {
        const finalText = rec.getResult(s).text.trim();
        if (finalText) {
          this.output.put({
            type: SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [this.#speechData(finalText)],
          });
        }
        if (started) {
          this.output.put({ type: SpeechEventType.END_OF_SPEECH });
          started = false;
        }
        rec.reset(s);
        lastText = "";
        lastChangeAt = 0;
        preflighted = false;
      }
    }
  }
}
