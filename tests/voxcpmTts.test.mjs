/**
 * Unit tests for the custom VoxCPM TTS adapter (src/voxcpmTts.mjs).
 *
 * Offline by default: construction + the request-body/voice-loading logic touch no
 * network (the constructor just reads config/voice; the fetch only happens inside
 * ChunkedStream.run()). The framing test mocks global.fetch with a raw-PCM body to
 * prove we emit frames correctly. Real synthesis is validated by a live call.
 *
 * The pieces worth pinning: that we request VoxCPM's raw-PCM mode (format:"pcm"),
 * that the fixed clone voice is loaded/sent (and omitted for zero-shot), and that the
 * headerless PCM body is framed with a final last frame.
 *
 * Run: node --test tests/voxcpmTts.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { tts, initializeLogger } from "@livekit/agents";
import { VoxcpmTTS, buildGenerateBody, readVoxcpmOpts } from "../src/voxcpmTts.mjs";

before(() => initializeLogger({ pretty: false, level: "silent" }));

// The committed reference-clone voice asset (path is relative to the project root,
// which is the cwd when tests run via `node --test tests/`).
const VOICE_FILE = "assets/voxcpm-voice.json";

const ENV = {
  TTS_PROVIDER: "voxcpm",
  VOXCPM_BASE_URL: "http://localhost:8001",
  VOXCPM_CFG_VALUE: "2",
  VOXCPM_MAX_GENERATE_LENGTH: "1500",
  VOXCPM_TEMPERATURE: "1",
};

test("VoxcpmTTS is a batch (non-streaming) 44.1kHz mono TTS, no network at construction", () => {
  const t = new VoxcpmTTS(ENV); // must not call out
  assert.ok(t instanceof tts.TTS);
  assert.equal(t.capabilities.streaming, false);
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.numChannels, 1);
  assert.equal(t.model, "voxcpm-1.5");
  assert.equal(t.provider, "localhost:8001"); // host of the baseURL
});

test("stream() is rejected (VoxCPM is request/response only)", () => {
  assert.throws(() => new VoxcpmTTS(ENV).stream(), /Streaming is not supported/);
});

test("readVoxcpmOpts loads the fixed clone voice from VOXCPM_VOICE_FILE", () => {
  const opts = readVoxcpmOpts({ ...ENV, VOXCPM_VOICE_FILE: VOICE_FILE });
  assert.ok(opts.voice, "voice should be loaded from the asset file");
  assert.ok(opts.voice.prompt_latents_base64.length > 0);
  assert.ok(opts.voice.prompt_text.length > 0);
  assert.equal(opts.cfgValue, 2);
  assert.equal(opts.maxGenerateLength, 1500);
  assert.equal(opts.temperature, 1);
});

test("readVoxcpmOpts falls back to zero-shot (no voice) when VOXCPM_VOICE_FILE is unset", () => {
  assert.equal(readVoxcpmOpts(ENV).voice, null);
});

test("buildGenerateBody requests raw PCM and includes the clone prompt when voiced", () => {
  const opts = readVoxcpmOpts({ ...ENV, VOXCPM_VOICE_FILE: VOICE_FILE });
  const body = buildGenerateBody("Hello there.", opts);
  assert.equal(body.format, "pcm");
  assert.equal(body.target_text, "Hello there.");
  assert.equal(body.max_generate_length, 1500); // capped < max_model_len - prompt tokens
  assert.equal(body.cfg_value, 2);
  assert.equal(body.prompt_text, opts.voice.prompt_text);
  assert.equal(body.prompt_latents_base64, opts.voice.prompt_latents_base64);
});

test("buildGenerateBody omits prompt_* for zero-shot (server rejects prompt_text without latents)", () => {
  const body = buildGenerateBody("Hi.", readVoxcpmOpts(ENV));
  assert.equal(body.format, "pcm");
  assert.ok(!("prompt_text" in body));
  assert.ok(!("prompt_latents_base64" in body));
});

test("synthesize sends format:pcm and emits the raw-PCM body as frames with a final last frame", async () => {
  // 10000 samples of int16 mono @44.1kHz -> >2 full 100ms frames (4410 each) plus a
  // remainder, so we exercise both write() framing and the flush() tail.
  const pcm = new Int16Array(10000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = ((i % 100) - 50) * 100;

  let capturedBody;
  let capturedUrl;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    // undici's global Response: arrayBuffer() returns these bytes back to the client.
    return new Response(pcm.buffer, { status: 200, headers: { "Content-Type": "audio/L16" } });
  };

  try {
    const t = new VoxcpmTTS({ ...ENV, VOXCPM_VOICE_FILE: VOICE_FILE });
    const events = [];
    for await (const ev of t.synthesize("Hello there.")) events.push(ev);

    assert.equal(capturedUrl, "http://localhost:8001/generate");
    assert.equal(capturedBody.format, "pcm");
    assert.ok(events.length > 0, "should emit at least one frame");
    assert.equal(events.at(-1).final, true, "last frame must be final");
    // Non-final framing on all but the last, single requestId across the segment.
    assert.ok(events.slice(0, -1).every((e) => e.final === false));
    assert.equal(new Set(events.map((e) => e.requestId)).size, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("synthesize streams a multi-chunk body with unaligned boundaries without losing samples", async () => {
  // The fix reads res.body incrementally, so AudioByteStream must reassemble samples
  // across chunk boundaries — including an ODD byte offset that splits a 16-bit sample.
  const total = 9000; // samples -> 2 full 100ms frames (8820) + 180 remainder (flush)
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) pcm[i] = ((i % 50) - 25) * 200;
  const bytes = new Uint8Array(pcm.buffer);
  // Cut at 1234 (even) and 9001 (odd -> mid-sample split) to stress reassembly.
  const chunks = [bytes.subarray(0, 1234), bytes.subarray(1234, 9001), bytes.subarray(9001)];
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "audio/L16" } });
  try {
    const t = new VoxcpmTTS(ENV); // zero-shot is fine here
    const frames = [];
    for await (const ev of t.synthesize("Hi.")) frames.push(ev);

    const totalSamples = frames.reduce((n, e) => n + e.frame.samplesPerChannel, 0);
    assert.equal(totalSamples, total, "all PCM samples preserved across chunk boundaries");
    assert.equal(frames.at(-1).final, true);
  } finally {
    global.fetch = originalFetch;
  }
});
