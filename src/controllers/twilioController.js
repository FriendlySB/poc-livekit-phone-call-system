/**
 * Twilio Controller
 * Handles incoming phone call webhooks and returns TwiML responses
 */

const twilio = require("twilio");
const { ConnectorClient } = require("livekit-server-sdk");
const { ConnectTwilioCallRequest_TwilioCallDirection } = require("@livekit/protocol");
const openAIRealtimeService = require("../services/openAIRealtimeService");
const elevenLabsService = require("../services/elevenLabsService");
const configurationService = require("../services/configurationService");
const outboundCallService = require("../services/outboundCallService");
const humanTransferService = require("../services/humanTransferService");
const { buildBridgeTwiml } = require("../bridgeTwiml");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// LiveKit Connector client — bridges Twilio Media Streams into a LiveKit room.
// Reads its endpoint/credentials from LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET.
const connectorClient = new ConnectorClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

/**
 * Handle incoming call webhook from Twilio
 * Returns TwiML with conference configuration for human agent support
 */
const handleIncomingCall = async (req, res) => {
  console.log("Incoming call webhook received");

  // Fetch configuration — includes a `provider` field ("elevenlabs" | "openai")
  const config = await configurationService.getPhoneCallSettings();

  const callSid = req.body.CallSid;
  // Strip + from phone numbers for consistency
  const callerNumber = req.body.From.replace(/^\+/, "");
  const twilioNumber = req.body.To.replace(/^\+/, "");

  // ElevenLabs path
  if (config.provider === "elevenlabs") {
    try {
      const { twiml, conversationId } = await elevenLabsService.registerCall(
        callerNumber,
        twilioNumber,
        config
      );

      if (conversationId) {
        elevenLabsService.storeConversationMetadata(
          conversationId,
          callSid,
          callerNumber,
          config.chatflowId,
          twilioNumber,
          config.humanAgentPhoneNumber,
          config.humanAgentTimeout
        );
      }

      // Return ElevenLabs-provided TwiML verbatim — Twilio will stream audio
      // directly to ElevenLabs; ServeAI is out of the audio path from here.
      res.type("text/xml");
      return res.send(twiml);
    } catch (error) {
      console.error("ElevenLabs registerCall failed:", error.message);
      // Fallback: play an error message and hang up
      const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we are unable to connect your call right now. Please try again later.</Say></Response>`;
      res.type("text/xml");
      return res.send(errorTwiml);
    }
  }

  // LiveKit path
  // Bridge the inbound call into a LiveKit room via the Twilio Connector.
  if (config.provider === "livekit") {
    // Self-hosted mode: the OSS livekit-server has no Twilio Connector, so route the
    // call to our own Twilio<->LiveKit bridge (src/services/livekitBridgeService.js)
    // with a <Connect><Stream>. This call's ServeAI config rides along as <Parameter>s,
    // which the bridge reads from the Media Streams `start` event and forwards to the
    // agent as dispatch metadata (same shape the Cloud path uses).
    if (process.env.LIVEKIT_MODE === "selfhost") {
      // Shared with the outbound answer webhook (see handleOutboundAnswer) so both
      // directions hand the bridge an identical <Parameter> set — that identity is why
      // the agent needs no notion of call direction.
      const twiml = buildBridgeTwiml({
        prompt: config.prompt,
        greeting: config.greeting,
        chatflowId: config.chatflowId,
        callSid,
        callerNumber,
        liveKitSTT: config.liveKitSTT,
        liveKitTTS: config.liveKitTTS,
      });
      res.type("text/xml");
      return res.send(twiml);
    }

    // Cloud mode: managed Twilio Connector (connectTwilioCall).
    try {
      // NOTE: bound to `connectRes`, NOT `res` — `res` is the Express response and
      // shadowing it here made every later res.type()/res.send() throw, which sent the
      // whole branch into the catch below and returned the error TwiML on every call.
      const connectRes = await connectorClient.connectTwilioCall({
        // The enum members are INBOUND/OUTBOUND. `TWILIO_CALL_DIRECTION_INBOUND` is the
        // protobuf wire name, not a TS member — reading it yields undefined, which only
        // happened to work because protobuf defaults this field to 0 (= INBOUND).
        twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.INBOUND,
        roomName: `call-${callSid}`,
        participantIdentity: callerNumber,
        participantName: callerNumber,
        // Explicit dispatch — agentName must match the worker's WorkerOptions.agentName.
        // metadata carries this call's prompt + greeting (from ServeAI config) to the
        // worker, which reads it as ctx.job.metadata. RoomAgentDispatch.metadata is a string.
        // chatflowId/callSid/callerNumber are added so the worker can persist the
        // conversation to ServeAI chat history (Step 3a); chatflowId may be undefined,
        // in which case the worker logs only and skips persistence.
        agents: [
          {
            agentName: "serveai-poc",
            metadata: JSON.stringify({
              prompt: config.prompt,
              greeting: config.greeting,
              chatflowId: config.chatflowId,
              callSid,
              callerNumber,
              // Per-call STT/TTS leg selection from ServeAI config (see agent.mjs).
              liveKitSTT: config.liveKitSTT,
              liveKitTTS: config.liveKitTTS,
            }),
          },
        ],
      });
      console.log(JSON.stringify(connectRes, null, 2));
      const connectUrl = connectRes.connectUrl;
      console.log("LiveKit connectTwilioCall succeeded, connectUrl:", connectUrl);

      // Stream the call's audio to LiveKit over the returned WebSocket URL.
      const twiml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Response><Connect><Stream url="${connectUrl}" /></Connect></Response>`;

      res.type("text/xml");
      return res.send(twiml);
    } catch (error) {
      console.log("Error connecting Twilio call to LiveKit:", error);
      console.error("LiveKit connectTwilioCall failed:", error.message);
      // Fallback: play an error message and hang up
      const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we are unable to connect your call right now. Please try again later.</Say></Response>`;
      res.type("text/xml");
      return res.send(errorTwiml);
    }
  }

  // OpenAI path (default)
  const conferenceName = callSid;
  const callToken = req.body.CallToken;

  // Store conference metadata with chatflowId
  openAIRealtimeService.storeConferenceMetadata(
    conferenceName,
    callerNumber,
    callToken,
    config.chatflowId
  );

  // Create voice agent (OpenAI) as SIP participant
  async function createParticipant() {
    try {
      await client.conferences(conferenceName).participants.create({
        from: callerNumber,
        label: "voice agent",
        to: `sip:${process.env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}`,
        earlyMedia: false,
        callToken: callToken,
        conferenceStatusCallback: `https://${process.env.HOST}/api/twilio/conference-events`,
        conferenceStatusCallbackEvent: ["join"],
      });
    } catch (error) {
      console.error("Error creating voice agent participant:", error);
    }
  }

  createParticipant();

  // Generate TwiML response with conference
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Dial>
            <Conference 
                startConferenceOnEnter="true"
                participantLabel="customer"
                endConferenceOnExit="true"
                statusCallback="https://${process.env.HOST}/api/twilio/conference-events"
                statusCallbackEvent="join leave end"
                waitUrl=""
            >
                ${conferenceName}
            </Conference>
        </Dial>
    </Response>`;

  res.type("text/xml");
  res.send(twiml);
};

/**
 * Handle call status updates from Twilio
 */
const handleCallStatus = (req, res) => {
  console.log("Call status update:", {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    From: req.body.From,
    To: req.body.To,
  });

  res.sendStatus(200);
};

/**
 * Handle conference events (participant join/leave, conference end)
 */
const handleConferenceEvents = async (req, res) => {
  const event = req.body;

  // Handle human agent joining - mute voice agent and start streaming both audio tracks
  if (event.ParticipantLabel === 'human agent' && event.StatusCallbackEvent === 'participant-join') {
    const conferenceName = event.FriendlyName;
    const humanAgentCallSid = event.CallSid;
    
    console.log(`Human agent joined conference ${conferenceName}, CallSid: ${humanAgentCallSid}`);
    
    // Mark human agent as active
    openAIRealtimeService.setHumanAgentActive(conferenceName, true);
    openAIRealtimeService.updateConferenceMetadata(conferenceName, { humanAgentCallSid });
    
    try {
      const participants = await client
        .conferences(event.ConferenceSid)
        .participants.list({ limit: 20 });
      
      for (const participant of participants) {
        // Kick the voice agent out of the conference
        // because transcription is handled via media streams
        if (participant.label === "voice agent") {
          await client
            .calls(participant.callSid)
            .update({ status: "completed" });
          
          console.log('Voice agent removed from conference');
          //openAIRealtimeService.muteVoiceAgent(conferenceName);
        }
        
        // Start streaming human agent audio
        if (participant.label === 'human agent') {
          await client
            .calls(participant.callSid)
            .streams.create({
              url: `wss://${process.env.HOST}/api/twilio/media-stream`,
              track: 'inbound_track',
              statusCallback: `https://${process.env.HOST}/api/twilio/stream-status`,
            });
          
          console.log('Started streaming human agent audio');
        }
        
        // Start streaming caller audio
        if (participant.label === 'customer') {
          await client
            .calls(participant.callSid)
            .streams.create({
              url: `wss://${process.env.HOST}/api/twilio/media-stream`,
              track: 'inbound_track',
              statusCallback: `https://${process.env.HOST}/api/twilio/stream-status`,
            });
          
          console.log('Started streaming caller audio');
          
          // Store caller callSid in metadata
          openAIRealtimeService.updateConferenceMetadata(conferenceName, {
            callerCallSid: participant.callSid
          });
        }
      }
    } catch (error) {
      console.error('Error setting up media streams:', error);
    }
  }

  // Handle human agent leaving
  if (event.ParticipantLabel === 'human agent' && event.StatusCallbackEvent === 'participant-leave') {
    const conferenceName = event.FriendlyName;
    openAIRealtimeService.setHumanAgentActive(conferenceName, false);
    
    try {
      const participants = await client
        .conferences(event.ConferenceSid)
        .participants.list({ limit: 20 });

      // When human agent leaves, remove the voice agent from the conference
      for (const participant of participants) {
        if (participant.label === "voice agent") {
          await client
            .calls(participant.callSid)
            .update({ status: "completed" });
          
          console.log('Voice agent removed from conference');
        }
      }
    } catch (error) {
      console.error('Error handling human agent leave:', error);
    }
  }

  // Handle conference end - cleanup
  if (event.StatusCallbackEvent === 'conference-end') {
    const conferenceName = event.FriendlyName;
    
    if (conferenceName) {
      openAIRealtimeService.cleanupConference(conferenceName);
    }
  }

  res.sendStatus(200);
};

/**
 * Handle conference events for ElevenLabs Phase 2 transfer conferences (transfer_conv_xxx).
 * Handles conference-end to trigger cleanup in elevenLabsService.
 * Stream start is handled directly by _handleAddHumanAgent — no need to act on participant-join here.
 */
const handleTransferConferenceEvents = async (req, res) => {
  res.sendStatus(200);
  const event = req.body;
  const conferenceName = event.FriendlyName;

  // LiveKit transfer conferences use their own prefix so they can't be confused with the
  // ElevenLabs ones below; the suffix is the caller's callSid rather than a conversationId.
  if (conferenceName?.startsWith(humanTransferService.CONFERENCE_PREFIX)) {
    if (event.StatusCallbackEvent === "conference-end") {
      const callSid = conferenceName.replace(humanTransferService.CONFERENCE_PREFIX, "");
      console.log(`Conference ended: ${conferenceName}`);
      humanTransferService.cleanupAfterHumanConferenceEnd(callSid);
    }
    return;
  }

  if (!conferenceName?.startsWith("transfer_")) return;

  const conversationId = conferenceName.replace("transfer_", "");

  if (event.StatusCallbackEvent === "conference-end") {
    console.log(`Conference ended: ${conferenceName}`);
    elevenLabsService.cleanupAfterHumanConferenceEnd(conversationId);
  }
};

/**
 * Place an outbound call that lands in a LiveKit room when the callee answers.
 * Body: { to, instruction?, greeting? }
 */
const handleOutboundCall = async (req, res) => {
  // The outbound path rides the self-hosted bridge. Cloud mode would need
  // connectTwilioCall(OUTBOUND) instead, which is deliberately out of scope.
  if (process.env.LIVEKIT_MODE !== "selfhost") {
    return res.status(400).json({
      success: false,
      error: "Outbound calling requires LIVEKIT_MODE=selfhost",
    });
  }

  const { to, instruction, greeting } = req.body || {};
  if (!to) {
    return res.status(400).json({ success: false, error: "`to` is required (E.164, e.g. +60123456789)" });
  }

  try {
    const result = await outboundCallService.placeCall({ to, instruction, greeting });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("Outbound call failed:", error.message);
    return res.status(502).json({ success: false, error: error.message });
  }
};

/**
 * Twilio fetches this the moment the callee picks up (see outboundCallService for why
 * the dial uses `url` rather than inline `twiml`). Returns the same bridge TwiML the
 * inbound path returns, so the agent cannot tell the directions apart.
 */
const handleOutboundAnswer = (req, res) => {
  const token = req.query.token;
  const pending = outboundCallService.getPending(token);

  if (!pending) {
    console.error(`Outbound answer: unknown or expired token ${token}`);
    const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be connected.</Say></Response>`;
    res.type("text/xml");
    return res.send(errorTwiml);
  }

  // CallSid from the webhook is authoritative — placeCall stores it too, but the webhook
  // can arrive before that assignment lands on a very fast pickup.
  const callSid = req.body?.CallSid || pending.callSid;

  const twiml = buildBridgeTwiml({
    prompt: pending.prompt,
    greeting: pending.greeting,
    chatflowId: pending.chatflowId,
    callSid,
    // The OTHER party — here the number we dialled — so ServeAI history stays keyed to
    // the contact in both directions.
    callerNumber: String(pending.to).replace(/^\+/, ""),
    liveKitSTT: pending.liveKitSTT,
    liveKitTTS: pending.liveKitTTS,
  });

  console.log(`Outbound answered: ${callSid} -> bridging to LiveKit`);
  res.type("text/xml");
  return res.send(twiml);
};

/**
 * Hand the caller to a human agent. Called by the LiveKit agent's transferToHumanAgent
 * tool over loopback — the agent worker is a separate process, and Twilio's status
 * callbacks land here, so the transfer state machine has to live in this process.
 * Body: { callSid, chatflowId?, callerNumber }
 */
const handleTransferToHuman = async (req, res) => {
  const { callSid, chatflowId, callerNumber } = req.body || {};
  if (!callSid) {
    return res.status(400).json({ success: false, result: "`callSid` is required" });
  }

  try {
    const result = await humanTransferService.transferToHuman({ callSid, chatflowId, callerNumber });
    return res.status(result.success ? 200 : 409).json(result);
  } catch (error) {
    console.error("Human transfer failed:", error.message);
    return res.status(500).json({ success: false, result: error.message });
  }
};

/**
 * Status callback for the human agent's outbound leg — resolves the answer race in
 * humanTransferService.
 */
const handleHumanTransferStatus = (req, res) => {
  res.sendStatus(200);
  humanTransferService.resolveTransfer(req.body.CallSid, req.body.CallStatus);
};

module.exports = {
  handleIncomingCall,
  handleCallStatus,
  handleConferenceEvents,
  handleTransferConferenceEvents,
  handleOutboundCall,
  handleOutboundAnswer,
  handleTransferToHuman,
  handleHumanTransferStatus,
};
