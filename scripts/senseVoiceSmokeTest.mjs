/**
 * Step-0 de-risk gate for the OFFLINE SenseVoice STT (NOT wired into the app).
 *
 * Loads the SenseVoice OfflineRecognizer (via the SAME getOfflineRecognizer the live STT
 * uses, so this can't drift from production), reads a WAV, decodes it in ONE pass (offline),
 * and prints the transcript + the real-time factor (RTF). This validates the two unknowns
 * cheaply BEFORE the integration is trusted: (1) the model loads via the senseVoice config,
 * and (2) English accuracy + CPU speed vs the Whisper budget. If English is garbled or RTF
 * isn't well under Whisper's ~0.7s, stop and reconsider.
 *
 * Usage:
 *   node scripts/senseVoiceSmokeTest.mjs <path/to/english.wav>
 *   # e.g. the English 8 kHz phone sample bundled with the zipformer model:
 *   node scripts/senseVoiceSmokeTest.mjs models/sherpa-onnx-streaming-zipformer-en-2023-06-21/test_wavs/8k.wav
 *
 * Model dir + filenames come from the same SENSEVOICE_* env vars the real STT uses. Note:
 * .env is NOT auto-loaded here — pass env inline if you've customized the paths.
 */

import sherpa from "sherpa-onnx-node";
import { existsSync } from "node:fs";
import { getOfflineRecognizer } from "../src/senseVoiceStt.mjs";

const wavPath = process.argv[2];
if (!wavPath || !existsSync(wavPath)) {
  console.error(
    `Usage: node scripts/senseVoiceSmokeTest.mjs <path/to/english.wav>\nWAV not found: ${wavPath ?? "(none given)"}`,
  );
  process.exit(1);
}

// Build the recognizer (loads the ~930 MB model — time it, since this is what prewarm pays).
const loadStart = Date.now();
const recognizer = getOfflineRecognizer(process.env);
console.log(`model loaded in ${Date.now() - loadStart}ms`);

// Read the WAV (returns { samples: Float32Array [-1,1], sampleRate }). sherpa resamples to
// the model's 16 kHz internally inside acceptWaveform, exactly like the live _recognize.
const wave = sherpa.readWave(wavPath);
console.log(
  `wav: ${wavPath} (${wave.sampleRate} Hz, ${(wave.samples.length / wave.sampleRate).toFixed(2)}s)`,
);

const decodeStart = Date.now();
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
recognizer.decode(stream); // single offline pass
const text = recognizer.getResult(stream).text;
const decodeSecs = (Date.now() - decodeStart) / 1000;
const audioSecs = wave.samples.length / wave.sampleRate;

console.log(`\n  [TEXT] ${text}`);
console.log(
  `\naudio=${audioSecs.toFixed(2)}s  decode=${decodeSecs.toFixed(2)}s  RTF=${(decodeSecs / audioSecs).toFixed(3)} (lower is faster; <1 = real-time)`,
);
