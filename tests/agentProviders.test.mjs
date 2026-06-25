/**
 * Unit tests for the voice-pipeline provider selection (src/agentProviders.mjs).
 *
 * These assert ONLY the wiring — that the right STT/TTS classes are built for a
 * given env, and that the Speaches paths are correctly wrapped in their stream
 * adapters. No network is touched (the plugin constructors don't call out; they
 * just store config), so these run fully offline with dummy keys.
 *
 * Run: node --test tests/agentProviders.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { stt, inference, initializeLogger } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import { createStt, createTts } from "../src/agentProviders.mjs";

// The ElevenLabs plugin grabs a logger at construction; the worker normally calls
// this during startup, so initialize it once before any provider is built.
before(() => initializeLogger({ pretty: false, level: "silent" }));

// Minimal env with dummy credentials for both providers.
const baseEnv = {
  ELEVENLABS_API_KEY: "test-elevenlabs-key",
  ELEVENLABS_VOICE_ID: "test-voice",
  SPEACHES_BASE_URL: "http://localhost:8000/v1",
  SPEACHES_API_KEY: "speaches",
  SPEACHES_STT_MODEL: "Systran/faster-whisper-base",
  SPEACHES_TTS_MODEL: "speaches-ai/Kokoro-82M-v1.0-ONNX",
  SPEACHES_TTS_VOICE: "af_heart",
};

// A real (but un-started) local VAD for the STT adapter; native model loads lazily
// on .stream(), so constructing it here is cheap and offline.
const vad = () => new inference.VAD({ model: "silero" });

test("default env -> ElevenLabs STT and TTS", () => {
  assert.ok(createStt(baseEnv, vad()) instanceof elevenlabs.STT);
  assert.ok(createTts(baseEnv) instanceof elevenlabs.TTS);
});

test("STT_PROVIDER=speaches -> batch STT wrapped in a StreamAdapter", () => {
  const s = createStt({ ...baseEnv, STT_PROVIDER: "speaches" }, vad());
  assert.ok(s instanceof stt.StreamAdapter);
});

test("TTS_PROVIDER=speaches -> non-streaming OpenAI TTS (no StreamAdapter)", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "speaches" });
  assert.ok(t instanceof openai.TTS);
});

test("legs are independent: Speaches TTS keeps ElevenLabs STT", () => {
  const env = { ...baseEnv, TTS_PROVIDER: "speaches" }; // STT_PROVIDER unset
  assert.ok(createStt(env, vad()) instanceof elevenlabs.STT);
  assert.ok(createTts(env) instanceof openai.TTS);
});
