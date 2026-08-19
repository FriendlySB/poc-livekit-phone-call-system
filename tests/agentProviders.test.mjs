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
import { SherpaSTT } from "../src/sherpaStt.mjs";
import { SenseVoiceSTT } from "../src/senseVoiceStt.mjs";
import { ChatterboxTTS } from "../src/chatterboxTts.mjs";
import { VoxcpmTTS } from "../src/voxcpmTts.mjs";

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
  CHATTERBOX_BASE_URL: "http://localhost:8004/v1",
  CHATTERBOX_API_KEY: "chatterbox",
  CHATTERBOX_TTS_MODEL: "chatterbox-turbo",
  CHATTERBOX_TTS_VOICE: "Emily.wav",
  // No VOXCPM_VOICE_FILE here -> VoxcpmTTS falls back to zero-shot silently (no file read).
  VOXCPM_BASE_URL: "http://localhost:8001",
  POCKET_BASE_URL: "http://localhost:49112/v1",
  POCKET_API_KEY: "pocket",
  POCKET_TTS_MODEL: "pocket-tts",
  POCKET_TTS_VOICE: "alba",
  VIBEVOICE_BASE_URL: "http://localhost:8020/v1",
  VIBEVOICE_API_KEY: "vibevoice",
  VIBEVOICE_TTS_MODEL: "vibevoice-realtime",
  VIBEVOICE_TTS_VOICE: "en-Emma_woman",
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

test("STT_PROVIDER=sherpa -> in-process streaming SherpaSTT (no model load)", () => {
  const s = createStt({ ...baseEnv, STT_PROVIDER: "sherpa" }, vad());
  assert.ok(s instanceof SherpaSTT);
  assert.equal(s.capabilities.streaming, true);
});

test("STT_PROVIDER=sensevoice -> offline SenseVoiceSTT wrapped in a StreamAdapter (no model load)", () => {
  const s = createStt({ ...baseEnv, STT_PROVIDER: "sensevoice" }, vad());
  assert.ok(s instanceof stt.StreamAdapter);
});

test("TTS_PROVIDER=speaches -> non-streaming OpenAI TTS (no StreamAdapter)", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "speaches" });
  assert.ok(t instanceof openai.TTS);
});

test("TTS_PROVIDER=chatterbox -> custom ChatterboxTTS (not the openai plugin)", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "chatterbox" });
  assert.ok(t instanceof ChatterboxTTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 24000);
  assert.equal(t.numChannels, 1);
});

test("TTS_PROVIDER=voxcpm -> custom VoxcpmTTS (not the openai plugin), 44.1kHz mono", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "voxcpm" });
  assert.ok(t instanceof VoxcpmTTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.numChannels, 1);
});

test("TTS_PROVIDER=pocket -> stock OpenAI TTS (Pocket's server is 24kHz PCM, so no custom client)", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "pocket" });
  assert.ok(t instanceof openai.TTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 24000);
  assert.equal(t.numChannels, 1);
});

test("TTS_PROVIDER=vibevoice -> stock OpenAI TTS (our shim serves 24kHz PCM, so no custom client)", () => {
  const t = createTts({ ...baseEnv, TTS_PROVIDER: "vibevoice" });
  assert.ok(t instanceof openai.TTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 24000);
  assert.equal(t.numChannels, 1);
});

test("TTS providers that share openai.TTS still point at their own servers", () => {
  // All three OpenAI-shaped legs build the same class, so the thing worth pinning is that
  // each reads its OWN base URL — a copy-paste slip would silently send VibeVoice text to
  // Speaches (both would return valid audio, in the wrong voice).
  assert.equal(createTts({ ...baseEnv, TTS_PROVIDER: "speaches" }).provider, "localhost:8000");
  assert.equal(createTts({ ...baseEnv, TTS_PROVIDER: "pocket" }).provider, "localhost:49112");
  assert.equal(createTts({ ...baseEnv, TTS_PROVIDER: "vibevoice" }).provider, "localhost:8020");
});

test("legs are independent: Speaches TTS keeps ElevenLabs STT", () => {
  const env = { ...baseEnv, TTS_PROVIDER: "speaches" }; // STT_PROVIDER unset
  assert.ok(createStt(env, vad()) instanceof elevenlabs.STT);
  assert.ok(createTts(env) instanceof openai.TTS);
});
