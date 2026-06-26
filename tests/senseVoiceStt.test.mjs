/**
 * Unit tests for the OFFLINE SenseVoice STT (src/senseVoiceStt.mjs).
 *
 * Offline + model-free: these assert the STT wiring/capabilities WITHOUT loading the ~930 MB
 * ONNX model (the recognizer is lazy — built in prewarm()/_recognize(), not the constructor).
 * Importing the module loads the native sherpa-onnx-node addon (installed), so this runs
 * without network or model files. Real transcription is validated by
 * scripts/senseVoiceSmokeTest.mjs + a live call.
 *
 * Run: node --test tests/senseVoiceStt.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { stt, initializeLogger } from "@livekit/agents";
import { SenseVoiceSTT } from "../src/senseVoiceStt.mjs";

before(() => initializeLogger({ pretty: false, level: "silent" }));

const ENV = {
  STT_PROVIDER: "sensevoice",
  SENSEVOICE_MODEL_DIR: "./models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09",
  SENSEVOICE_LANGUAGE: "en",
};

test("SenseVoiceSTT is a batch (non-streaming) STT and loads no model at construction", () => {
  const s = new SenseVoiceSTT(ENV); // must not touch the filesystem / build a recognizer
  assert.ok(s instanceof stt.STT);
  assert.equal(s.capabilities.streaming, false);
  assert.equal(s.capabilities.interimResults, false);
  assert.equal(s.provider, "sherpa-onnx-sensevoice");
});

test("stream() is rejected (SenseVoice is batch-only; the StreamAdapter supplies streaming)", () => {
  const s = new SenseVoiceSTT(ENV);
  assert.throws(() => s.stream(), /batch-only/);
});
