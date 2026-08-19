/**
 * Unit tests for the conference transcriber factory (src/services/conferenceTranscriber.js).
 *
 * This module decides who transcribes the caller <-> human-agent conversation after a
 * handoff. Both providers speak the OpenAI Realtime protocol, so the socket lifecycle is
 * shared and only URL/auth/audio-encoding differ.
 *
 * The load-bearing assertion here is that the DEFAULT is still OpenAI: twilioStreamService
 * is shared by three call paths (OpenAI Realtime, ElevenLabs transfer, LiveKit transfer),
 * and two of them were working in production before this factory existed.
 *
 * WebSocket is injected, so nothing opens a socket.
 *
 * Run: node --test tests/conferenceTranscriber.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createConferenceTranscriber,
  buildProviderConfig,
  resolveProvider,
  toWsUrl,
} from "../src/services/conferenceTranscriber.js";

const ENV_MODEL = "deepdml/faster-whisper-large-v3-turbo-ct2";

const ENV = {
  OPENAI_API_KEY: "sk-test",
  SPEACHES_BASE_URL: "http://localhost:8000/v1",
  SPEACHES_API_KEY: "speaches",
};

/** Minimal ws stand-in: records sends, exposes handlers so tests can drive events. */
class FakeWebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.sent = [];
    this.closed = false;
    this.readyState = 1; // OPEN — matches ws.OPEN
    this.handlers = {};
  }
  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  }
  emit(event, arg) {
    this.handlers[event]?.(arg);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
}

/** Capture the socket the factory builds, so assertions can reach it. */
function makeCapture() {
  const made = [];
  class Capturing extends FakeWebSocket {
    constructor(url, opts) {
      super(url, opts);
      made.push(this);
    }
  }
  return { made, Capturing };
}

// --- provider selection ---------------------------------------------------------------

test("defaults to OpenAI — the no-regression guard for the two existing paths", () => {
  assert.equal(resolveProvider({}), "openai");
  assert.equal(resolveProvider({ CONFERENCE_STT_PROVIDER: "openai" }), "openai");
});

test("ServeAI config overrides env, mirroring how liveKitSTT overrides STT_PROVIDER", () => {
  assert.equal(resolveProvider({ CONFERENCE_STT_PROVIDER: "openai" }, "speaches"), "speaches");
  assert.equal(resolveProvider({ CONFERENCE_STT_PROVIDER: "speaches" }), "speaches");
});

test("toWsUrl upgrades the scheme and strips the trailing slash", () => {
  assert.equal(toWsUrl("http://localhost:8000/v1"), "ws://localhost:8000/v1");
  assert.equal(toWsUrl("https://speaches.example.com/v1/"), "wss://speaches.example.com/v1");
});

// --- provider configs -----------------------------------------------------------------

test("openai: cloud URL, bearer key, and mu-law passed through untouched", () => {
  const cfg = buildProviderConfig("openai", ENV);

  assert.match(cfg.url, /^wss:\/\/api\.openai\.com\/v1\/realtime\?model=/);
  assert.equal(cfg.headers.Authorization, "Bearer sk-test");
  // Twilio already sends base64 mu-law, which is what audio/pcmu expects.
  assert.equal(cfg.session.session.audio.input.format.type, "audio/pcmu");
  assert.equal(cfg.encode("AAAA"), "AAAA");
});

test("openai: language is configurable, no longer hardcoded to en", () => {
  const cfg = buildProviderConfig("openai", { ...ENV, CONFERENCE_STT_LANGUAGE: "ms" });
  assert.equal(cfg.session.session.audio.input.transcription.language, "ms");
  // ...and still defaults to en when unset, so existing deployments don't shift.
  assert.equal(buildProviderConfig("openai", ENV).session.session.audio.input.transcription.language, "en");
});

test("speaches: local realtime URL carries intent=transcription and the turbo model", () => {
  const cfg = buildProviderConfig("speaches", ENV);

  assert.ok(cfg.url.startsWith("ws://localhost:8000/v1/realtime?"), `got ${cfg.url}`);
  assert.match(cfg.url, /intent=transcription/);
  assert.match(cfg.url, /model=deepdml%2Ffaster-whisper-large-v3-turbo-ct2/);
  assert.equal(cfg.headers.Authorization, "Bearer speaches");
  // The model must ALSO be set in the session: the URL parameter alone leaves the
  // session on the server's default (Systran/faster-distil-whisper-small.en).
  assert.equal(cfg.session.session.input_audio_transcription.model, ENV_MODEL);
});

test("speaches: create_response is false — without it the session dies after one transcript", () => {
  // The single most important assertion in this file. Speaches defaults create_response
  // to true, so it tries to generate a chat reply after every completed transcript. This
  // deployment has no chat LLM, so that raises InternalServerError inside the session's
  // asyncio TaskGroup and tears the socket down — verified live: exactly one transcript
  // arrived, then the connection closed. `?intent=transcription` does NOT prevent it.
  const { session } = buildProviderConfig("speaches", ENV).session;
  assert.equal(session.turn_detection.create_response, false);

  // Speaches' TurnDetection model requires all four fields, so the remaining three must
  // be present; they carry the server's own defaults so VAD behaviour is unchanged.
  assert.deepEqual(session.turn_detection, {
    type: "server_vad",
    create_response: false,
    threshold: 0.9,
    prefix_padding_ms: 0,
    silence_duration_ms: 550,
  });
});

test("speaches: input_audio_format is never sent", () => {
  // The server replies "Specifying `session.input_audio_format` is not supported" and
  // drops the field. Format is fixed at pcm16 @ 16 kHz, which is what encode() produces.
  const { session } = buildProviderConfig("speaches", ENV).session;
  assert.equal(session.input_audio_format, undefined);
  assert.deepEqual(Object.keys(session), ["input_audio_transcription", "turn_detection"]);
});

test("speaches: the unavoidable prefix_padding_ms error is not logged as a failure", () => {
  // prefix_padding_ms cannot be omitted (required by the model) and cannot be accepted
  // (rejected by the handler), so every session draws one benign error event. It must not
  // surface as an error, or it will mask a real one — which is how the 404 stayed hidden.
  const { made, Capturing } = makeCapture();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    createConferenceTranscriber({
      env: ENV,
      provider: "speaches",
      participantType: "caller",
      onTranscript: () => {},
      WebSocketImpl: Capturing,
    });
    made[0].emit(
      "message",
      JSON.stringify({
        type: "error",
        error: { message: "Specifying `session.turn_detection.prefix_padding_ms` is not supported." },
      }),
    );
    assert.deepEqual(errors, []);

    // Any other server error must still be reported.
    made[0].emit("message", JSON.stringify({ type: "error", error: { message: "model not found" } }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /model not found/);
  } finally {
    console.error = originalError;
  }
});

test("speaches: mu-law is decoded and upsampled 8k -> 24k", () => {
  const cfg = buildProviderConfig("speaches", ENV);
  // Speaches reads appended bytes as RAW pcm16 @ 24 kHz and then resamples them to the
  // 16 kHz its VAD and Whisper run at, so 24 kHz is the wire rate. This ratio is worth a
  // dedicated test because getting it wrong fails SILENTLY: at 16 kHz the server scales
  // the audio by 2/3, speech plays 1.5x too fast, and Whisper returns confident nonsense
  // ("Thank you.") rather than an error.
  const out = cfg.encode(Buffer.from([0xff, 0x7f, 0x00, 0x80]).toString("base64"));
  assert.notEqual(out, "AAAA", "must not pass mu-law through");
  // 4 mu-law bytes -> 4 samples -> 12 samples after 3x -> 24 bytes of PCM16.
  assert.equal(Buffer.from(out, "base64").length, 24);
});

// --- socket behaviour -----------------------------------------------------------------

test("sends session.update on open and forwards audio as input_audio_buffer.append", () => {
  const { made, Capturing } = makeCapture();
  const t = createConferenceTranscriber({
    env: ENV,
    participantType: "caller",
    onTranscript: () => {},
    WebSocketImpl: Capturing,
  });

  const ws = made[0];
  ws.emit("open");
  assert.equal(ws.sent[0].type, "session.update");

  t.push("BASE64AUDIO");
  assert.deepEqual(ws.sent[1], { type: "input_audio_buffer.append", audio: "BASE64AUDIO" });
});

test("caller leg emits 'user', human leg emits 'humanAgent'", () => {
  for (const [participantType, expected] of [
    ["caller", "user"],
    ["human-agent", "humanAgent"],
  ]) {
    const { made, Capturing } = makeCapture();
    const got = [];
    createConferenceTranscriber({
      env: ENV,
      participantType,
      onTranscript: (type, text) => got.push([type, text]),
      WebSocketImpl: Capturing,
    });

    made[0].emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello there",
      }),
    );

    assert.deepEqual(got, [[expected, "hello there"]]);
  }
});

test("ignores unrelated events and blank transcripts", () => {
  const { made, Capturing } = makeCapture();
  const got = [];
  createConferenceTranscriber({
    env: ENV,
    participantType: "caller",
    onTranscript: (type, text) => got.push([type, text]),
    WebSocketImpl: Capturing,
  });

  const ws = made[0];
  ws.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  ws.emit(
    "message",
    JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "   " }),
  );
  ws.emit("message", "not json at all"); // must not throw

  assert.deepEqual(got, []);
});

test("close() closes the underlying socket", () => {
  const { made, Capturing } = makeCapture();
  const t = createConferenceTranscriber({
    env: ENV,
    participantType: "caller",
    onTranscript: () => {},
    WebSocketImpl: Capturing,
  });
  t.close();
  assert.equal(made[0].closed, true);
});
