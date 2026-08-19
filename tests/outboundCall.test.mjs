/**
 * Unit tests for outbound dialing (src/services/outboundCallService.js).
 *
 * The Twilio client and ServeAI config service are injected, so nothing reaches the
 * network. The two properties worth pinning:
 *
 *   1. The dial uses `url`, NOT inline `twiml`. Twilio fetches a `url` only when the
 *      callee ANSWERS — that is what keeps the agent from greeting a ringing phone, and
 *      it is the entire reason src/agent.mjs needed no changes for outbound.
 *   2. Per-request instruction/greeting override ServeAI, while chatflowId and the
 *      STT/TTS legs pass through untouched — chatflowId gates both persistence and the
 *      agent's tool set, so dropping it would silently disable ServeAI tools on outbound.
 *
 * Run: node --test tests/outboundCall.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { placeCall, getPending } from "../src/services/outboundCallService.js";

before(() => {
  process.env.HOST = "example.ngrok.app";
  process.env.TWILIO_NUMBER = "60111222333";
});

const SERVE_AI_CONFIG = {
  prompt: "ServeAI default prompt",
  greeting: "ServeAI default greeting",
  chatflowId: "cf_123",
  liveKitSTT: "sherpa",
  liveKitTTS: "pocket",
  humanAgentPhoneNumber: "+60999888777",
};

/** Twilio stand-in that records calls.create args and returns a fixed sid. */
function makeTwilioStub(sid = "CA_outbound") {
  const created = [];
  return {
    created,
    client: {
      calls: Object.assign(
        (callSid) => ({ update: async () => {}, streams: { create: async () => {} } }),
        {
          create: async (args) => {
            created.push(args);
            return { sid };
          },
        },
      ),
    },
  };
}

const configStub = { getPhoneCallSettings: async () => ({ ...SERVE_AI_CONFIG }) };

function deps(twilioStub) {
  return { client: twilioStub.client, configurationService: configStub };
}

test("dials with `url` (fetched on answer), never inline twiml", async () => {
  const t = makeTwilioStub();
  await placeCall({ to: "+60123456789" }, deps(t));

  const args = t.created[0];
  assert.ok(args.url, "must pass a url so Twilio fetches TwiML on answer");
  assert.equal(args.twiml, undefined, "inline twiml would execute before pickup");
  assert.match(args.url, /\/api\/phone-call\/twilio\/outbound-answer\?token=/);
  // The answer route is POST-only; a GET would 404 and silently drop the call.
  assert.equal(args.method, "POST");
  assert.equal(args.to, "+60123456789");
  assert.equal(args.from, "+60111222333");
});

test("requests the status callbacks needed to classify the outcome", async () => {
  const t = makeTwilioStub();
  await placeCall({ to: "+60123456789" }, deps(t));

  const args = t.created[0];
  assert.match(args.statusCallback, /\/api\/phone-call\/twilio\/call-status$/);
  // "completed" carries the final disposition (no-answer / busy / failed).
  assert.ok(args.statusCallbackEvent.includes("completed"));
  assert.ok(args.statusCallbackEvent.includes("answered"));
});

test("token round-trips: the answer webhook can recover this call's config", async () => {
  const t = makeTwilioStub("CA_roundtrip");
  const { token, callSid } = await placeCall({ to: "+60123456789" }, deps(t));

  const pending = getPending(token);
  assert.ok(pending, "token must resolve to the stored config");
  assert.equal(pending.to, "+60123456789");
  assert.equal(callSid, "CA_roundtrip");
  // The sid is attached after create resolves, for the transfer flow.
  assert.equal(pending.callSid, "CA_roundtrip");

  // The token in the URL must be the one we can look up — a mismatch would strand the call.
  const urlToken = new URL(t.created[0].url).searchParams.get("token");
  assert.equal(urlToken, token);
});

test("per-request instruction/greeting override ServeAI; the rest passes through", async () => {
  const t = makeTwilioStub();
  const { token } = await placeCall(
    {
      to: "+60123456789",
      instruction: "You are calling Friendly about a promotion.",
      greeting: "Hello, may I speak to Friendly?",
    },
    deps(t),
  );

  const pending = getPending(token);
  assert.equal(pending.prompt, "You are calling Friendly about a promotion.");
  assert.equal(pending.greeting, "Hello, may I speak to Friendly?");
  // chatflowId gates ServeAI persistence AND the agent's tools — it must survive.
  assert.equal(pending.chatflowId, "cf_123");
  assert.equal(pending.liveKitSTT, "sherpa");
  assert.equal(pending.liveKitTTS, "pocket");
});

test("without overrides it falls back to the ServeAI prompt and greeting", async () => {
  const t = makeTwilioStub();
  const { token } = await placeCall({ to: "+60123456789" }, deps(t));

  const pending = getPending(token);
  assert.equal(pending.prompt, "ServeAI default prompt");
  assert.equal(pending.greeting, "ServeAI default greeting");
});

test("an unknown token resolves to null rather than a half-built call", async () => {
  assert.equal(getPending("not-a-real-token"), null);
  assert.equal(getPending(undefined), null);
});

test("`to` is required", async () => {
  const t = makeTwilioStub();
  await assert.rejects(() => placeCall({}, deps(t)), /`to` is required/);
  assert.equal(t.created.length, 0, "must not dial without a destination");
});
