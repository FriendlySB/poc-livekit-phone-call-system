/**
 * Unit tests for the sherpa-onnx streaming STT (src/sherpaStt.mjs).
 *
 * Offline + model-free: these assert the pure Int16->Float32 conversion and the STT
 * wiring/capabilities WITHOUT loading the ONNX model (the recognizer is lazy — built in
 * prewarm()/run(), not the constructor). Importing the module does load the native
 * sherpa-onnx-node addon, which is installed, so this runs without network or model files.
 * Real transcription is validated by scripts/sherpaSmokeTest.mjs + a live call.
 *
 * Run: node --test tests/sherpaStt.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { stt, initializeLogger } from "@livekit/agents";
import { SherpaSTT, int16ToFloat32 } from "../src/sherpaStt.mjs";

before(() => initializeLogger({ pretty: false, level: "silent" }));

const ENV = {
  STT_PROVIDER: "sherpa",
  SHERPA_STT_MODEL_DIR: "./models/sherpa-onnx-streaming-zipformer-en-2023-06-21",
  SHERPA_STT_LANGUAGE: "en",
};

test("int16ToFloat32 maps Int16 PCM to [-1, 1)", () => {
  const out = int16ToFloat32(Int16Array.from([0, 16384, -32768, 32767]));
  assert.ok(out instanceof Float32Array);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0.5); // 16384 / 32768
  assert.equal(out[2], -1); // -32768 / 32768
  assert.ok(Math.abs(out[3] - 32767 / 32768) < 1e-6);
});

test("SherpaSTT is a streaming STT and loads no model at construction", () => {
  const s = new SherpaSTT(ENV); // must not touch the filesystem / build a recognizer
  assert.ok(s instanceof stt.STT);
  assert.equal(s.capabilities.streaming, true);
  assert.equal(s.capabilities.interimResults, true);
  assert.equal(s.provider, "sherpa-onnx");
});

test("_recognize is rejected (sherpa is streaming-only; the session uses stream())", async () => {
  const s = new SherpaSTT(ENV);
  await assert.rejects(() => s.recognize({}), /streaming-only/);
});
