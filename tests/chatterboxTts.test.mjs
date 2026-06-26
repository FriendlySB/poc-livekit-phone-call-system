/**
 * Unit tests for the custom Chatterbox TTS adapter (src/chatterboxTts.mjs).
 *
 * Offline + network-free: these assert the TTS wiring/capabilities and the WAV-header
 * parser WITHOUT touching the Chatterbox server (the constructor just stores config; the
 * fetch only happens inside ChunkedStream.run()). Real synthesis is validated by a live call.
 *
 * The WAV parser is the one piece of real logic worth pinning: it's what lets us feed
 * Chatterbox's wav-only output into LiveKit's raw-PCM AudioByteStream.
 *
 * Run: node --test tests/chatterboxTts.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { tts, initializeLogger } from "@livekit/agents";
import { ChatterboxTTS, parseWav } from "../src/chatterboxTts.mjs";

before(() => initializeLogger({ pretty: false, level: "silent" }));

const ENV = {
  TTS_PROVIDER: "chatterbox",
  CHATTERBOX_BASE_URL: "http://localhost:8004/v1",
  CHATTERBOX_API_KEY: "chatterbox",
  CHATTERBOX_TTS_MODEL: "chatterbox-turbo",
  CHATTERBOX_TTS_VOICE: "Emily.wav",
};

test("ChatterboxTTS is a batch (non-streaming) 24kHz mono TTS, no network at construction", () => {
  const t = new ChatterboxTTS(ENV); // must not call out
  assert.ok(t instanceof tts.TTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 24000);
  assert.equal(t.numChannels, 1);
  assert.equal(t.model, "chatterbox-turbo");
  assert.equal(t.provider, "localhost:8004"); // host of the baseURL
});

test("stream() is rejected (Chatterbox is request/response only)", () => {
  const t = new ChatterboxTTS(ENV);
  assert.throws(() => t.stream(), /Streaming is not supported/);
});

/**
 * Build a minimal canonical 44-byte pcm_16 mono WAV around `samples` (Int16Array)
 * at the given rate — mirrors what soundfile emits for response_format="wav".
 */
function makeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);            // PCM
  v.setUint16(22, 1, true);            // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);            // block align
  v.setUint16(34, 16, true);           // bits per sample
  ascii(36, "data"); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

test("parseWav recovers the data chunk and sample rate from a canonical WAV", () => {
  const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
  const { pcm, sampleRate } = parseWav(makeWav(samples, 24000));
  assert.equal(sampleRate, 24000);
  assert.equal(pcm.byteLength, samples.length * 2);
  // The recovered bytes must equal the original little-endian int16 payload.
  const recovered = new Int16Array(pcm.buffer, pcm.byteOffset, samples.length);
  assert.deepEqual([...recovered], [...samples]);
});

test("parseWav skips an extra LIST chunk placed before data", () => {
  // Splice a tiny "LIST" chunk between fmt and data to prove we walk subchunks
  // rather than assuming a fixed 44-byte header.
  const samples = Int16Array.from([5, 6, 7, 8]);
  const base = new Uint8Array(makeWav(samples, 24000));
  const listBody = new TextEncoder().encode("INFOxx"); // 6 bytes (even, no padding)
  const list = new Uint8Array(8 + listBody.length);
  const lv = new DataView(list.buffer);
  "LIST".split("").forEach((c, i) => lv.setUint8(i, c.charCodeAt(0)));
  lv.setUint32(4, listBody.length, true);
  list.set(listBody, 8);
  // Insert the LIST chunk at byte 36 (right where "data" starts in the canonical layout).
  const spliced = new Uint8Array(base.length + list.length);
  spliced.set(base.subarray(0, 36), 0);
  spliced.set(list, 36);
  spliced.set(base.subarray(36), 36 + list.length);

  const { pcm, sampleRate } = parseWav(spliced.buffer);
  assert.equal(sampleRate, 24000);
  const recovered = new Int16Array(pcm.buffer, pcm.byteOffset, samples.length);
  assert.deepEqual([...recovered], [...samples]);
});

test("parseWav rejects a non-WAV buffer", () => {
  assert.throws(() => parseWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer), /RIFF\/WAVE/);
});
