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
  // connectTwilioCall provisions the room, dispatches our named agent
  // ("serveai-poc"), and returns a WebSocket URL that Twilio streams audio to.
  // ServeAI is out of the audio path from here — LiveKit owns the conversation.
  if (config.provider === "livekit") {
    try {
      const { connectUrl } = await connectorClient.connectTwilioCall({
        twilioCallDirection:
          ConnectTwilioCallRequest_TwilioCallDirection.TWILIO_CALL_DIRECTION_INBOUND,
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
            }),
          },
        ],
      });

      // Stream the call's audio to LiveKit over the returned WebSocket URL.
      const twiml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Response><Connect><Stream url="${connectUrl}" /></Connect></Response>`;

      res.type("text/xml");
      return res.send(twiml);
    } catch (error) {
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

  if (!conferenceName?.startsWith("transfer_")) return;

  const conversationId = conferenceName.replace("transfer_", "");

  if (event.StatusCallbackEvent === "conference-end") {
    console.log(`Conference ended: ${conferenceName}`);
    elevenLabsService.cleanupAfterHumanConferenceEnd(conversationId);
  }
};

module.exports = {
  handleIncomingCall,
  handleCallStatus,
  handleConferenceEvents,
  handleTransferConferenceEvents,
};
