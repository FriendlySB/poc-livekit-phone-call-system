/**
 * Outbound calling for the LiveKit path.
 *
 * HOW IT WORKS
 * ------------
 * Twilio is asked to dial with `calls.create({ url })` rather than an inline `twiml`.
 * That matters: Twilio fetches the `url` only **when the callee picks up**, so the
 * <Connect><Stream> — and therefore the bridge, the agent dispatch, and the greeting —
 * all happen on answer. There is no window where the agent is talking to a ringing
 * phone, which is why outbound needed no changes to src/agent.mjs.
 *
 * WHY A TOKEN AND NOT THE CallSid
 * -------------------------------
 * The answer webhook needs this call's prompt/greeting/chatflowId. Keying that by CallSid
 * would race: the sid only exists once `calls.create` resolves, and on a fast pickup the
 * webhook can arrive first. So the config is stored under a random token that is baked
 * into the webhook URL before the dial is placed.
 *
 * Entries are NOT deleted on read — Twilio retries a failed TwiML fetch, and a retry
 * must find the same config. They expire on a timer instead.
 */

const { randomUUID } = require("crypto");
const twilio = require("twilio");
const configurationService = require("./configurationService");

// Built on first use rather than at import: twilio() throws without credentials, and this
// module must stay importable (and unit-testable) without them.
let _client;
function getClient() {
  if (!_client) _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

// Long enough to outlive ringing + a Twilio TwiML retry, short enough that an
// unanswered call can't leak an entry for the life of the process.
const PENDING_TTL_MS = 2 * 60 * 1000;

/** token -> per-call config consumed by the outbound answer webhook. */
const pending = new Map();

/**
 * Place an outbound call that lands in a LiveKit room on answer.
 *
 * @param {object} opts
 * @param {string} opts.to            - E.164 destination, e.g. "+60123456789"
 * @param {string} [opts.instruction] - overrides the ServeAI prompt for this call only
 * @param {string} [opts.greeting]    - overrides the ServeAI greeting for this call only
 * @param {object} [deps]             - test seam (same style as createServeAiTools)
 * @returns {Promise<{callSid:string, token:string, to:string}>}
 */
async function placeCall({ to, instruction, greeting }, deps = {}) {
  const twilioClient = deps.client || getClient();
  const configService = deps.configurationService || configurationService;

  if (!to) throw new Error("`to` is required");
  if (!process.env.TWILIO_NUMBER) throw new Error("TWILIO_NUMBER is not configured");
  if (!process.env.HOST) throw new Error("HOST is not configured");

  // Same ServeAI config the inbound webhook uses — chatflowId (which gates persistence
  // AND the agent's tool set) and the per-call STT/TTS legs come from here. Only the
  // prompt and greeting are overridable per request.
  const config = await configService.getPhoneCallSettings();

  const token = randomUUID();
  pending.set(token, {
    prompt: instruction ?? config.prompt,
    greeting: greeting ?? config.greeting,
    chatflowId: config.chatflowId,
    liveKitSTT: config.liveKitSTT,
    liveKitTTS: config.liveKitTTS,
    to,
  });
  setTimeout(() => pending.delete(token), PENDING_TTL_MS).unref?.();

  const host = process.env.HOST;
  const call = await twilioClient.calls.create({
    to,
    from: `+${String(process.env.TWILIO_NUMBER).replace(/^\+/, "")}`,
    // Fetched on ANSWER — see the module header.
    url: `https://${host}/api/phone-call/twilio/outbound-answer?token=${token}`,
    // Explicit because the route is POST-only; a GET here would 404 and drop the call.
    method: "POST",
    statusCallback: `https://${host}/api/phone-call/twilio/call-status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  // The transfer flow and the status callback both identify the call by sid.
  pending.get(token).callSid = call.sid;

  console.log(`Outbound call placed to ${to}, SID: ${call.sid}, token: ${token}`);
  return { callSid: call.sid, token, to };
}

/**
 * Look up the config for an answered outbound call.
 * @param {string} token
 * @returns {object|null}
 */
function getPending(token) {
  return pending.get(token) ?? null;
}

module.exports = { placeCall, getPending, _pending: pending };
