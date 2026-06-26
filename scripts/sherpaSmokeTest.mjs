/**
 * Step-0 de-risk gate for the sherpa-onnx streaming STT (NOT wired into the app).
 *
 * Loads the streaming English zipformer recognizer, feeds a WAV through it in small
 * chunks (simulating the live call's frame-by-frame audio), and prints the interim
 * (partial) transcripts, the final transcript, and the real-time factor (RTF). This
 * validates the one real unknown — English accuracy + CPU speed — BEFORE we build the
 * LiveKit integration. If accuracy on phone-style audio is unacceptable here, stop.
 *
 * Usage:
 *   node scripts/sherpaSmokeTest.mjs                 # uses the model's bundled test_wavs/0.wav
 *   node scripts/sherpaSmokeTest.mjs path/to/my.wav  # your own clip (mono WAV; phone audio for realism)
 *
 * Model dir + filenames come from the same env vars the real STT uses (defaults below
 * match the recommended 2023-06-21 model). See README for the download command.
 */

import sherpa from "sherpa-onnx-node";
import { join } from "node:path";
import { existsSync } from "node:fs";
// Reuse the SAME options builder the live STT uses, so the gate test can't drift from
// production and so it supports both transducer (zipformer) and paraformer model types.
import { buildRecognizerOptions } from "../src/sherpaStt.mjs";

const MODEL_DIR =
  process.env.SHERPA_STT_MODEL_DIR || "./models/sherpa-onnx-streaming-zipformer-en-2023-06-21";

// Build the streaming recognizer (loads the model — time it, since this is what prewarm pays).
// buildRecognizerOptions resolves files from env + fails fast with a clear message if missing.
const loadStart = Date.now();
const recognizer = new sherpa.OnlineRecognizer(buildRecognizerOptions(process.env));
console.log(`model loaded in ${Date.now() - loadStart}ms`);

// Read the WAV (returns { samples: Float32Array [-1,1], sampleRate }).
const wavPath = process.argv[2] || join(MODEL_DIR, "test_wavs", "0.wav");
if (!existsSync(wavPath)) {
  console.error(`WAV not found: ${wavPath}`);
  process.exit(1);
}
const wave = sherpa.readWave(wavPath);
console.log(`wav: ${wavPath} (${wave.sampleRate} Hz, ${(wave.samples.length / wave.sampleRate).toFixed(2)}s)`);

// Stream it in 100ms chunks, exactly like the live STT will feed audio frames.
const stream = recognizer.createStream();
const chunk = Math.floor((wave.sampleRate * 100) / 1000);
const decodeStart = Date.now();
let lastPartial = "";

for (let i = 0; i < wave.samples.length; i += chunk) {
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(i, i + chunk) });
  while (recognizer.isReady(stream)) recognizer.decode(stream);

  const text = recognizer.getResult(stream).text;
  if (text && text !== lastPartial) {
    lastPartial = text;
    console.log(`  [partial] ${text}`);
  }
  if (recognizer.isEndpoint(stream)) {
    const finalText = recognizer.getResult(stream).text;
    if (finalText) console.log(`  [FINAL]   ${finalText}`);
    recognizer.reset(stream);
    lastPartial = "";
  }
}

// Tail padding (0.3s silence) + flush so the last utterance finalizes.
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.floor(wave.sampleRate * 0.3)) });
stream.inputFinished();
while (recognizer.isReady(stream)) recognizer.decode(stream);
const tailText = recognizer.getResult(stream).text;
if (tailText) console.log(`  [FINAL]   ${tailText}`);

const decodeSecs = (Date.now() - decodeStart) / 1000;
const audioSecs = wave.samples.length / wave.sampleRate;
console.log(
  `\naudio=${audioSecs.toFixed(2)}s  decode=${decodeSecs.toFixed(2)}s  RTF=${(decodeSecs / audioSecs).toFixed(3)} (lower is faster; <1 = real-time)`
);
