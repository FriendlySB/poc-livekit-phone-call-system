/**
 * Cold human-agent takeover for the LiveKit path.
 *
 * FLOW
 * ----
 *   1. Dial the human into a *waiting* conference (startConferenceOnEnter=false, so they
 *      hold until the caller arrives).
 *   2. Wait for them to answer, bounded by humanAgentTimeout from ServeAI config.
 *   3. Redirect the caller's leg into that conference with calls(sid).update({ twiml }).
 *   4. Fork both legs' inbound audio to twilioStreamService for transcription.
 *
 * WHY STEP 3 MAKES THIS "COLD"
 * ----------------------------
 * Redirecting the caller's leg TERMINATES its <Connect><Stream>, so the LiveKit bridge
 * WebSocket closes and the agent job shuts down — the caller ends up 1:1 with the human.
 * agent.mjs's shutdown callback flushes its ServeAI persist queue on that same path, so
 * the AI half of the transcript is already safe by the time we get here.
 *
 * That is also why no SIP is involved: a Twilio leg cannot be in a conference AND hold a
 * bidirectional <Connect><Stream> at once, so bridging LiveKit *into* the conference
 * would have required SIP. A cold handoff never needs LiveKit in the conference at all.
 *
 * Modelled on elevenLabsService's Phase-2 transfer (the proven production path), minus
 * its conversationId/conversationMetadata coupling — here the identity is the callSid.
 */

const twilio = require("twilio");
const configurationService = require("./configurationService");
const chatbotService = require("./chatbotService");

// Built on first use rather than at import: twilio() throws without credentials, and this
// module must stay importable (and unit-testable) without them.
let _client;
function getClient() {
  if (!_client) _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

// Prefixed so it can't collide with the ElevenLabs "transfer_" conferences, whose
// handler in twilioController keys off that exact prefix.
const CONFERENCE_PREFIX = "lktransfer_";

/**
 * legCallSid -> transcription routing for that leg.
 * Both the caller's and the human's leg are registered; `chatCallSid` is the CALLER's sid
 * on both, because that is what the ServeAI chatroom is keyed to.
 * @type {Map<string, {chatCallSid:string, chatflowId:string, participantType:string, conferenceName:string, queue:{persist:Function}}>}
 */
const transferParticipants = new Map();

/** outboundCallSid -> resolver for the "did the human pick up?" race. */
const pendingTransfers = new Map();

/**
 * Resolve the answer race. Called by the human-transfer status webhook.
 * @param {string} outboundCallSid
 * @param {string} status - Twilio CallStatus
 */
function resolveTransfer(outboundCallSid, status) {
  const entry = pendingTransfers.get(outboundCallSid);
  if (!entry) return;

  if (status === "in-progress" || status === "answered") {
    pendingTransfers.delete(outboundCallSid);
    entry.resolve("answered");
  } else if (["busy", "no-answer", "failed", "canceled", "completed"].includes(status)) {
    pendingTransfers.delete(outboundCallSid);
    entry.resolve("failed");
  }
}

/**
 * Register a conference leg so twilioStreamService can route its transcripts.
 * @param {string} legCallSid
 * @param {object} record
 */
function storeTransferParticipant(legCallSid, record) {
  transferParticipants.set(legCallSid, record);
  console.log(
    `LiveKit transfer: registered ${record.participantType} leg ${legCallSid} -> chat ${record.chatCallSid}`
  );
}

/**
 * Look up a conference leg for media-stream routing (used by twilioStreamService).
 * @param {string} legCallSid
 * @returns {object|null}
 */
function getTransferParticipant(legCallSid) {
  return transferParticipants.get(legCallSid) ?? null;
}

/**
 * Drop both legs and the ServeAI session once the conference ends.
 * @param {string} callSid - the caller's callSid (conference name suffix)
 */
function cleanupAfterHumanConferenceEnd(callSid) {
  for (const [legSid, record] of transferParticipants) {
    if (record.chatCallSid === callSid) transferParticipants.delete(legSid);
  }
  chatbotService.clearSession(callSid);
  console.log(`LiveKit transfer: cleaned up conference for ${callSid}`);
}

/**
 * Start both media-stream forks for conference transcription.
 *
 * `<Start><Stream>` (what streams.create issues) is UNIDIRECTIONAL, which is exactly why
 * it can coexist with <Dial><Conference> on a leg where <Connect><Stream> cannot. We only
 * need to listen, never to inject.
 */
async function startTranscriptionStreams(twilioClient, host, legs) {
  await Promise.all(
    legs.map(async ({ sid, label }) => {
      try {
        await twilioClient.calls(sid).streams.create({
          // Note the path: the media-stream WS upgrade is handled directly in index.js at
          // /api/twilio/media-stream, NOT under the /api/phone-call router prefix.
          url: `wss://${host}/api/twilio/media-stream`,
          track: "inbound_track",
          statusCallback: `https://${host}/api/phone-call/twilio/stream-status`,
        });
        console.log(`LiveKit transfer: started media stream for ${label} (${sid})`);
      } catch (err) {
        console.error(`LiveKit transfer: media stream failed for ${label} (${sid}):`, err.message);
      }
    })
  );
}

/**
 * Hand the caller off to a human agent.
 *
 * @param {object} opts
 * @param {string} opts.callSid      - the caller's Twilio call SID (from agent dispatch metadata)
 * @param {string} [opts.chatflowId] - ServeAI chatflow; absent -> transcription is skipped
 * @param {string} opts.callerNumber - the other party's number; REQUIRED for correct chatroom resolution
 * @param {object} [deps]            - test seam (same style as createServeAiTools)
 * @returns {Promise<{success:boolean, result:string}>}
 */
async function transferToHuman({ callSid, chatflowId, callerNumber }, deps = {}) {
  const twilioClient = deps.client || getClient();
  const configService = deps.configurationService || configurationService;
  const chatbot = deps.chatbotService || chatbotService;

  if (!callSid) return { success: false, result: "callSid is required" };

  const config = await configService.getPhoneCallSettings();
  const humanAgentPhoneNumber = config.humanAgentPhoneNumber || process.env.HUMAN_AGENT_NUMBER;
  if (!humanAgentPhoneNumber) {
    return { success: false, result: "No human agent number is configured" };
  }

  const host = process.env.HOST;
  const conferenceName = `${CONFERENCE_PREFIX}${callSid}`;
  const toNumber = humanAgentPhoneNumber.startsWith("+")
    ? humanAgentPhoneNumber
    : `+${humanAgentPhoneNumber}`;
  const fromNumber = `+${String(process.env.TWILIO_NUMBER).replace(/^\+/, "")}`;

  // Human agent holds in the conference until the caller is redirected in.
  const humanAgentTwiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Dial>` +
    `<Conference participantLabel="human agent" startConferenceOnEnter="false" waitUrl="" beep="false">${conferenceName}</Conference>` +
    `</Dial></Response>`;

  let resolveDeferred;
  const waitForAnswer = new Promise((resolve) => {
    resolveDeferred = resolve;
  });

  let outboundCallSid;
  try {
    const call = await twilioClient.calls.create({
      to: toNumber,
      from: fromNumber,
      twiml: humanAgentTwiml,
      statusCallback: `https://${host}/api/phone-call/twilio/human-transfer-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });
    outboundCallSid = call.sid;
    pendingTransfers.set(outboundCallSid, { resolve: resolveDeferred });
    console.log(`LiveKit transfer: dialing ${toNumber}, outbound SID: ${outboundCallSid}`);
  } catch (err) {
    console.error("LiveKit transfer: failed to dial human agent:", err.message);
    return { success: false, result: "Failed to reach the human agent" };
  }

  const answerTimeoutMs = (config.humanAgentTimeout || 40) * 1000;
  const outcome = await Promise.race([
    waitForAnswer,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), answerTimeoutMs)),
  ]);

  if (outcome !== "answered") {
    pendingTransfers.delete(outboundCallSid);
    try {
      await twilioClient.calls(outboundCallSid).update({ status: "completed" });
    } catch {
      /* already ended */
    }
    console.log(`LiveKit transfer: ${outcome} for ${callSid}`);
    return { success: false, result: "The human agent did not answer" };
  }

  // Seed the ServeAI chatroom BEFORE any insert. insertUserMessage calls
  // getChatId(callSid, chatflowId) WITHOUT the number, and getChatId creates a fresh
  // session on a cache miss — and this process's cache is always cold, because the AI
  // half of the call was persisted by the *agent* worker, a separate process. Without
  // this seeded call the human conversation would land in a brand-new chatroom.
  // Same hazard persistQueue.mjs documents; reuse it so ordering is handled there too.
  let queue = null;
  if (chatflowId) {
    const { createPersistQueue } = await import("../persistQueue.mjs");
    queue = createPersistQueue(chatbot, { chatflowId, callSid, callerNumber });
  }

  // Redirect the caller out of the LiveKit bridge and into the conference.
  const callerTwiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Dial>` +
    `<Conference participantLabel="customer" startConferenceOnEnter="true" endConferenceOnExit="true" beep="false" ` +
    `statusCallback="https://${host}/api/phone-call/twilio/transfer-conference-events" ` +
    `statusCallbackEvent="join leave end" statusCallbackMethod="POST">` +
    `${conferenceName}</Conference>` +
    `</Dial></Response>`;

  try {
    await twilioClient.calls(callSid).update({ twiml: callerTwiml });
    console.log(`LiveKit transfer: caller ${callSid} redirected to ${conferenceName}`);
  } catch (err) {
    console.error("LiveKit transfer: failed to redirect caller:", err.message);
    return { success: false, result: "Failed to connect you to the human agent" };
  }

  if (queue) {
    // One queue shared by BOTH legs, so caller and human turns stay globally ordered.
    storeTransferParticipant(callSid, {
      chatCallSid: callSid,
      chatflowId,
      participantType: "caller",
      conferenceName,
      queue,
    });
    storeTransferParticipant(outboundCallSid, {
      chatCallSid: callSid,
      chatflowId,
      participantType: "human-agent",
      conferenceName,
      queue,
    });

    await startTranscriptionStreams(twilioClient, host, [
      { sid: callSid, label: "caller" },
      { sid: outboundCallSid, label: "human-agent" },
    ]);
  } else {
    console.warn(`LiveKit transfer: no chatflowId for ${callSid} — conference not transcribed`);
  }

  return { success: true, result: "Call transferred successfully to the human agent" };
}

module.exports = {
  transferToHuman,
  resolveTransfer,
  storeTransferParticipant,
  getTransferParticipant,
  cleanupAfterHumanConferenceEnd,
  CONFERENCE_PREFIX,
};
