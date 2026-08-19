/**
 * Regression guard for the bridge TwiML builder (src/bridgeTwiml.js).
 *
 * buildBridgeTwiml was EXTRACTED from twilioController.handleIncomingCall so the outbound
 * answer webhook could reuse it. Inbound is the working production path, so the thing
 * worth pinning is that the extraction produces byte-identical output — this test embeds
 * the pre-refactor template literal and diffs against it.
 *
 * Pure and offline: no env, no network, no Twilio.
 *
 * Run: node --test tests/bridgeTwiml.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBridgeTwiml, escapeXmlAttr } from "../src/bridgeTwiml.js";

const HOST = "example.ngrok.app";

const CONFIG = {
  prompt: "You are a friendly phone assistant.",
  greeting: "Hello, how can I help you?",
  chatflowId: "cf_123",
  callSid: "CA_test",
  callerNumber: "60123456789",
  liveKitSTT: "sherpa",
  liveKitTTS: "vibevoice",
};

/**
 * The ORIGINAL implementation, copied verbatim from twilioController.js before the
 * extraction. Kept here deliberately duplicated — that is the point of the guard.
 */
function originalTwiml(config, callSid, callerNumber, host) {
  const bridgeUrl = `wss://${host}/api/twilio/livekit-bridge`;
  const esc = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const params = [
    ["prompt", config.prompt],
    ["greeting", config.greeting],
    ["chatflowId", config.chatflowId],
    ["callSid", callSid],
    ["callerNumber", callerNumber],
    ["liveKitSTT", config.liveKitSTT],
    ["liveKitTTS", config.liveKitTTS],
  ]
    .map(([name, value]) => `<Parameter name="${name}" value="${esc(value)}" />`)
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${bridgeUrl}">${params}</Stream></Connect></Response>`
  );
}

test("byte-identical to the pre-refactor inbound TwiML", () => {
  const expected = originalTwiml(CONFIG, CONFIG.callSid, CONFIG.callerNumber, HOST);
  const actual = buildBridgeTwiml({ ...CONFIG, host: HOST });
  assert.equal(actual, expected);
});

test("byte-identical when the optional fields are absent", () => {
  // ServeAI may omit chatflowId (-> agent runs tool-less) and the STT/TTS overrides.
  const sparse = {
    prompt: "p",
    greeting: "g",
    callSid: "CA_x",
    callerNumber: "60111",
  };
  const expected = originalTwiml(sparse, sparse.callSid, sparse.callerNumber, HOST);
  const actual = buildBridgeTwiml({ ...sparse, host: HOST });
  assert.equal(actual, expected);
  // undefined must serialise as an empty attribute, not the string "undefined".
  assert.ok(actual.includes('<Parameter name="chatflowId" value="" />'));
});

test("escapes XML-significant characters in the prompt", () => {
  // ServeAI prompts routinely contain & and quotes; unescaped they break the document
  // and Twilio rejects the whole response.
  const nasty = {
    ...CONFIG,
    prompt: 'Ask about "specials" & <promotions>',
  };
  const actual = buildBridgeTwiml({ ...nasty, host: HOST });

  assert.ok(actual.includes("&amp;"), "& must be escaped");
  assert.ok(actual.includes("&quot;specials&quot;"), "double quotes must be escaped");
  assert.ok(actual.includes("&lt;promotions&gt;"), "angle brackets must be escaped");
  // No raw delimiter may survive inside the attribute value.
  const attr = actual.match(/name="prompt" value="([^"]*)"/);
  assert.ok(attr, "prompt attribute should still parse as a quoted attribute");
  assert.ok(!attr[1].includes("<"), "no raw < inside the attribute");
});

test("escapeXmlAttr handles null/undefined as empty string", () => {
  assert.equal(escapeXmlAttr(undefined), "");
  assert.equal(escapeXmlAttr(null), "");
  assert.equal(escapeXmlAttr(0), "0");
});

test("both directions produce the same shape for the same inputs", () => {
  // Inbound passes the CALLER's number; outbound passes the DIALLED number. Different
  // values, identical structure — this is why the agent needs no direction flag.
  const inbound = buildBridgeTwiml({ ...CONFIG, callerNumber: "60123456789", host: HOST });
  const outbound = buildBridgeTwiml({ ...CONFIG, callerNumber: "60987654321", host: HOST });

  assert.equal(
    inbound.replace("60123456789", "#"),
    outbound.replace("60987654321", "#"),
  );
});
