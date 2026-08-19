/**
 * TwiML builder for the self-hosted Twilio <-> LiveKit bridge.
 *
 * Both call directions hand Twilio the exact same thing: a <Connect><Stream> pointed at
 * src/services/livekitBridgeService.js, with this call's ServeAI config riding along as
 * <Parameter>s. The bridge reads those from the Media Streams `start` event and forwards
 * them to the agent as dispatch metadata.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Extracted verbatim from twilioController.handleIncomingCall so the outbound answer
 * webhook emits byte-identical TwiML. That identity is the whole reason outbound needed
 * no agent changes: the bridge — and therefore the agent — cannot tell the two directions
 * apart. tests/bridgeTwiml.test.mjs pins the output so the extraction can't drift.
 *
 * Pure and offline: no env reads beyond the `host` default, no network, no SDK.
 */

/**
 * Escape a value for use inside a double-quoted XML attribute.
 *
 * The prompt comes from ServeAI and routinely contains `&` and quotes; unescaped they
 * would break the TwiML document and Twilio would reject the whole response.
 * @param {unknown} v
 * @returns {string}
 */
function escapeXmlAttr(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the <Connect><Stream> TwiML that hands a call leg to the LiveKit bridge.
 *
 * @param {object} opts
 * @param {string} opts.prompt        - system prompt for the agent (ServeAI config, or a per-call override)
 * @param {string} opts.greeting      - first line the agent speaks once the stream is up
 * @param {string} [opts.chatflowId]  - gates ServeAI persistence AND the tool set in agent.mjs
 * @param {string} opts.callSid       - Twilio call SID; correlates ServeAI chat history
 * @param {string} opts.callerNumber  - the OTHER party's number (caller on inbound, callee on outbound)
 * @param {string} [opts.liveKitSTT]  - per-call STT leg; absent -> agent falls back to its env default
 * @param {string} [opts.liveKitTTS]  - per-call TTS leg; same fallback
 * @param {string} [opts.host]        - public host for the bridge URL; defaults to process.env.HOST
 * @returns {string} TwiML document
 */
function buildBridgeTwiml({
  prompt,
  greeting,
  chatflowId,
  callSid,
  callerNumber,
  liveKitSTT,
  liveKitTTS,
  host = process.env.HOST,
}) {
  const bridgeUrl = `wss://${host}/api/twilio/livekit-bridge`;
  const params = [
    ["prompt", prompt],
    ["greeting", greeting],
    ["chatflowId", chatflowId],
    ["callSid", callSid],
    ["callerNumber", callerNumber],
    // Per-call STT/TTS leg selection from ServeAI config (agent reads these as the
    // provider keys; absent -> agent falls back to its env defaults).
    ["liveKitSTT", liveKitSTT],
    ["liveKitTTS", liveKitTTS],
  ]
    .map(([name, value]) => `<Parameter name="${name}" value="${escapeXmlAttr(value)}" />`)
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${bridgeUrl}">${params}</Stream></Connect></Response>`
  );
}

module.exports = { buildBridgeTwiml, escapeXmlAttr };
