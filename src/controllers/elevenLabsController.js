/**
 * ElevenLabs Controller
 * Handles post-call webhooks, tool webhooks, and debug endpoints
 */

const elevenLabsService = require("../services/elevenLabsService");

/**
 * POST /api/phone-call/elevenlabs/webhook
 *
 * Receives post-call webhooks from ElevenLabs after a conversation ends.
 * ElevenLabs sends the full conversation object directly at the top level —
 * there is NO { type, data } wrapper.
 *
 * Key top-level fields used here:
 *   conversation_id   — ElevenLabs conversation ID
 *   transcript        — [{ role, message, time_in_call_secs, ... }]
 *   status            — "done" on normal completion
 *   analysis          — { transcript_summary, call_successful, ... }
 *   metadata          — call duration, phone numbers, termination_reason, etc.
 *
 * We respond 200 immediately, then process the transcript asynchronously.
 */
const handlePostCallWebhook = async (req, res) => {
  // Respond immediately so ElevenLabs doesn't retry
  res.status(200).json({ received: true });

  try {
    let body = req.body;

    // Body arrives as a raw Buffer (express.raw middleware in index.js)
    if (Buffer.isBuffer(body)) {
      body = body.toString("utf8");
    }

    // TODO: Verify HMAC signature using ELEVENLABS_WEBHOOK_SECRET before production
    // const signature = req.headers["elevenlabs-signature"];

    let event;
    try {
      event = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      console.error("ElevenLabs webhook: failed to parse body as JSON");
      return;
    }

    const { type, data, event_timestamp } = event;

    console.log(`ElevenLabs webhook received — type: ${type}, timestamp: ${event_timestamp}`);

    if (type === "post_call_transcription") {
      const conversationId = data?.conversation_id;
      const terminationReason = data?.metadata?.termination_reason;

      console.log(
        `ElevenLabs post-call webhook — conversation: ${conversationId}, reason: ${terminationReason}`
      );

      if (data?.analysis?.transcript_summary) {
        console.log(`Call summary: ${data.analysis.transcript_summary}`);
      }

      if (Array.isArray(data?.transcript) && data.transcript.length > 0) {
        elevenLabsService.processTranscript(data).catch((err) => {
          console.error(`processTranscript error for ${conversationId}:`, err.message);
        });
      } else {
        console.log(`No transcript in webhook for conversation ${conversationId}`);
      }
    } else {
      console.log(`ElevenLabs webhook — unhandled type "${type}"`);
    }
  } catch (error) {
    console.error("ElevenLabs webhook error:", error.message);
  }
};

/**
 * POST /api/phone-call/elevenlabs/tool/:toolName
 *
 * Receives tool call webhooks from ElevenLabs during an active conversation.
 * ElevenLabs calls this when the agent decides to invoke a configured tool.
 *
 * Body: { parameters: { query: "..." }, conversation_id: "conv_xxx" }
 * Response: { result: "<string>" } on success, { error: "..." } on failure
 */
const handleToolWebhook = async (req, res) => {
  await elevenLabsService.handleToolWebhook(req.params.toolName, req, res);
};

/**
 * POST /api/phone-call/elevenlabs/transfer-status
 *
 * Twilio status callback for the outbound call leg dialed to the human agent.
 * Fired with CallStatus = "answered" when the agent picks up, or "completed" /
 * "no-answer" / "busy" / "failed" when the call ends without an answer.
 *
 * We respond 200 immediately, then tell elevenLabsService to resolve the deferred
 * promise that _handleAddHumanAgent is waiting on.
 */
const handleTransferStatus = (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus } = req.body;
  console.log(`ElevenLabs transfer status: ${CallSid} → ${CallStatus}`);
  elevenLabsService.resolveTransfer(CallSid, CallStatus);
};

/**
 * GET /api/phone-call/elevenlabs/sessions
 * Debug endpoint — returns all active ElevenLabs conversations tracked in memory
 */
const getActiveSessions = (req, res) => {
  res.json({ sessions: elevenLabsService.getActiveSessions() });
};

module.exports = { handlePostCallWebhook, handleToolWebhook, handleTransferStatus, getActiveSessions };
