/**
 * Unit tests for the cold human-agent handoff (src/services/humanTransferService.js).
 *
 * THE ONE THAT MATTERS: the chatroom-seeding guard.
 * chatbotService.insertUserMessage internally calls getChatId(callSid, chatflowId) WITHOUT
 * the phone number, and getChatId CREATES a new session on a cache miss. Express is a
 * different process from the agent worker, so its cache is always cold here — an unseeded
 * insert would resolve the chatroom with mobile:undefined, miss the lookup-by-number, and
 * silently write the entire human conversation into a SECOND chatroom. The fix is to seed
 * getChatId WITH callerNumber before anything is inserted, and that is what this pins.
 *
 * Twilio, ServeAI config, and chatbotService are all injected — no network.
 *
 * Run: node --test tests/humanTransfer.test.mjs
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  transferToHuman,
  resolveTransfer,
  getTransferParticipant,
  cleanupAfterHumanConferenceEnd,
  CONFERENCE_PREFIX,
} from "../src/services/humanTransferService.js";

before(() => {
  process.env.HOST = "example.ngrok.app";
  process.env.TWILIO_NUMBER = "60111222333";
});

const IDS = { callSid: "CA_caller", chatflowId: "cf_123", callerNumber: "60123456789" };

const configStub = (overrides = {}) => ({
  getPhoneCallSettings: async () => ({
    humanAgentPhoneNumber: "+60999888777",
    humanAgentTimeout: 5,
    ...overrides,
  }),
});

/**
 * Twilio stand-in. `autoAnswer` resolves the pickup race on the next tick, which is what
 * the real statusCallback webhook does via resolveTransfer().
 */
function makeTwilioStub({ autoAnswer = true, humanSid = "CA_human" } = {}) {
  const created = [];
  const updates = [];
  const streams = [];

  const client = {
    calls: Object.assign(
      (sid) => ({
        update: async (args) => {
          updates.push({ sid, args });
        },
        streams: {
          create: async (args) => {
            streams.push({ sid, args });
          },
        },
      }),
      {
        create: async (args) => {
          created.push(args);
          if (autoAnswer) {
            // Fires after transferToHuman registers the pending entry.
            setImmediate(() => resolveTransfer(humanSid, "in-progress"));
          }
          return { sid: humanSid };
        },
      },
    ),
  };

  return { created, updates, streams, client };
}

/** chatbotService stand-in recording the call ORDER, which is what the seeding test needs. */
function makeChatbotStub() {
  const order = [];
  return {
    order,
    getChatId: async (callSid, chatflowId, mobile) => {
      order.push({ fn: "getChatId", callSid, chatflowId, mobile });
      return "chat_1";
    },
    insertUserMessage: async (callSid, chatflowId, msg) => {
      order.push({ fn: "insertUserMessage", callSid, chatflowId, msg });
    },
    insertBotMessage: async (callSid, chatflowId, msg, type) => {
      order.push({ fn: "insertBotMessage", callSid, chatflowId, msg, type });
    },
    clearSession: () => {},
  };
}

function deps(twilioStub, chatbot, config = configStub()) {
  return { client: twilioStub.client, configurationService: config, chatbotService: chatbot };
}

test("seeds the ServeAI chatroom WITH callerNumber before any insert", async () => {
  const t = makeTwilioStub();
  const chatbot = makeChatbotStub();

  const res = await transferToHuman(IDS, deps(t, chatbot));
  assert.equal(res.success, true);

  const seed = chatbot.order.find((c) => c.fn === "getChatId");
  assert.ok(seed, "getChatId must be called to seed the session");
  // The whole point: WITHOUT this number the chatroom lookup-by-phone misses and a second
  // chatroom is created, splitting the transcript in two.
  assert.equal(seed.mobile, IDS.callerNumber);
  assert.equal(seed.callSid, IDS.callSid);
  assert.equal(seed.chatflowId, IDS.chatflowId);

  // And it must be first — an insert before the seed would defeat it.
  assert.equal(chatbot.order[0].fn, "getChatId");
});

test("registers BOTH legs against the caller's chat session", async () => {
  const t = makeTwilioStub({ humanSid: "CA_human_2" });
  await transferToHuman({ ...IDS, callSid: "CA_caller_2" }, deps(t, makeChatbotStub()));

  const callerLeg = getTransferParticipant("CA_caller_2");
  const humanLeg = getTransferParticipant("CA_human_2");

  assert.ok(callerLeg && humanLeg, "both legs must be routable by twilioStreamService");
  assert.equal(callerLeg.participantType, "caller");
  assert.equal(humanLeg.participantType, "human-agent");

  // Both legs write to the CALLER's chatroom — the human's leg has its own unrelated sid.
  assert.equal(callerLeg.chatCallSid, "CA_caller_2");
  assert.equal(humanLeg.chatCallSid, "CA_caller_2");
  // One shared queue keeps caller and human turns globally ordered.
  assert.equal(callerLeg.queue, humanLeg.queue);

  cleanupAfterHumanConferenceEnd("CA_caller_2");
  assert.equal(getTransferParticipant("CA_caller_2"), null);
  assert.equal(getTransferParticipant("CA_human_2"), null);
});

test("forks BOTH legs to the transcription stream", async () => {
  const t = makeTwilioStub({ humanSid: "CA_human_3" });
  await transferToHuman({ ...IDS, callSid: "CA_caller_3" }, deps(t, makeChatbotStub()));

  assert.equal(t.streams.length, 2, "caller and human must both be transcribed");
  const sids = t.streams.map((s) => s.sid).sort();
  assert.deepEqual(sids, ["CA_caller_3", "CA_human_3"]);

  for (const { args } of t.streams) {
    // Unidirectional fork — this is what can coexist with <Dial><Conference>.
    assert.equal(args.track, "inbound_track");
    // The media-stream upgrade is handled in index.js, outside the /api/phone-call router.
    assert.match(args.url, /^wss:\/\/.+\/api\/twilio\/media-stream$/);
  }

  cleanupAfterHumanConferenceEnd("CA_caller_3");
});

test("redirects the caller into the conference, which ends the LiveKit bridge", async () => {
  const t = makeTwilioStub({ humanSid: "CA_human_4" });
  await transferToHuman({ ...IDS, callSid: "CA_caller_4" }, deps(t, makeChatbotStub()));

  const redirect = t.updates.find((u) => u.sid === "CA_caller_4");
  assert.ok(redirect, "the caller's leg must be redirected");
  assert.match(redirect.args.twiml, /<Conference[^>]*>lktransfer_CA_caller_4<\/Conference>/);
  // endConferenceOnExit so hanging up tears the whole thing down.
  assert.match(redirect.args.twiml, /endConferenceOnExit="true"/);

  // The human waits rather than starting the conference alone.
  assert.match(t.created[0].twiml, /startConferenceOnEnter="false"/);
  assert.equal(t.created[0].to, "+60999888777");

  cleanupAfterHumanConferenceEnd("CA_caller_4");
});

test("no answer: reports failure, cancels the leg, and leaves the caller on the agent", async () => {
  const t = makeTwilioStub({ autoAnswer: false, humanSid: "CA_human_5" });
  const chatbot = makeChatbotStub();

  const res = await transferToHuman(
    { ...IDS, callSid: "CA_caller_5" },
    // 10ms timeout so the test doesn't wait on the real 40s default.
    deps(t, chatbot, configStub({ humanAgentTimeout: 0.01 })),
  );

  assert.equal(res.success, false);
  assert.match(res.result, /did not answer/);

  // The ringing leg must be hung up, not left dangling.
  const cancel = t.updates.find((u) => u.sid === "CA_human_5");
  assert.equal(cancel?.args.status, "completed");

  // Critically, the caller was NOT redirected — the agent keeps the call.
  assert.equal(t.updates.find((u) => u.sid === "CA_caller_5"), undefined);
  assert.equal(t.streams.length, 0, "nothing to transcribe if the handoff never happened");
  assert.equal(chatbot.order.length, 0, "no chatroom work on a failed transfer");
});

test("missing human agent number fails cleanly without dialing", async () => {
  const t = makeTwilioStub();
  const prev = process.env.HUMAN_AGENT_NUMBER;
  delete process.env.HUMAN_AGENT_NUMBER;

  const res = await transferToHuman(
    IDS,
    deps(t, makeChatbotStub(), configStub({ humanAgentPhoneNumber: null })),
  );

  assert.equal(res.success, false);
  assert.equal(t.created.length, 0);
  if (prev !== undefined) process.env.HUMAN_AGENT_NUMBER = prev;
});

test("conference prefix cannot collide with the ElevenLabs transfer_ conferences", () => {
  assert.equal(CONFERENCE_PREFIX, "lktransfer_");
  // twilioController routes on prefix; if this started with "transfer_" the ElevenLabs
  // handler would try to clean up a conversationId that does not exist.
  assert.ok(!CONFERENCE_PREFIX.startsWith("transfer_"));
});
