const openAIRealtimeService = require("./openAIRealtimeService");
const elevenLabsService = require("./elevenLabsService");
const humanTransferService = require("./humanTransferService");
const chatbotService = require("./chatbotService");
const { createConferenceTranscriber } = require("./conferenceTranscriber");

class TwilioStreamService {
  constructor() {
    this.activeStreams = new Map(); // callSid -> { ws, transcriber, streamSid, participantType, conferenceName }
  }

  /**
   * Handle new Twilio Media Stream WS connection
   */
  handleConnection(ws, req) {
    console.log("Twilio media stream connected");

    let callSid = null;
    let streamSid = null;
    let transcriber = null;
    let conferenceName = null;
    let participantType = null;

    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw);

      switch (msg.event) {
        case "start":
          callSid = msg.start.callSid;
          streamSid = msg.start.streamSid;

          let onTranscript;

          // Try OpenAI conference first
          conferenceName = openAIRealtimeService.getConferenceNameByCallSid(callSid);
          participantType = openAIRealtimeService.getParticipantTypeByCallSid(callSid);

          if (conferenceName && participantType) {
            // OpenAI path — queue message for sequential insertion
            onTranscript = (messageType, transcript) => {
              openAIRealtimeService.queueMessage(conferenceName, messageType, transcript);
            };
          } else {
            // ElevenLabs human agent transfer conference path
            const elevenLabsParticipant = elevenLabsService.getTransferParticipant(callSid);
            // LiveKit human agent transfer conference path
            const liveKitParticipant = humanTransferService.getTransferParticipant(callSid);

            if (elevenLabsParticipant) {
              conferenceName = elevenLabsParticipant.conferenceName;
              participantType = elevenLabsParticipant.participantType;
              const { conversationId } = elevenLabsParticipant;
              onTranscript = (messageType, transcript) => {
                elevenLabsService.insertHumanConferenceMessage(conversationId, participantType, transcript)
                  .catch(err => console.error(`Human conference insert error for ${conversationId}:`, err.message));
              };
            } else if (liveKitParticipant) {
              conferenceName = liveKitParticipant.conferenceName;
              participantType = liveKitParticipant.participantType;
              const { chatCallSid, chatflowId, queue } = liveKitParticipant;
              // Both legs share ONE queue, so caller and human turns land in submission
              // order. chatCallSid is the CALLER's sid on both legs — that is what the
              // ServeAI chatroom is keyed to (the human's leg has its own, unrelated sid).
              onTranscript = (messageType, transcript) => {
                queue.persist(() =>
                  messageType === "user"
                    ? chatbotService.insertUserMessage(chatCallSid, chatflowId, transcript)
                    : chatbotService.insertBotMessage(chatCallSid, chatflowId, transcript, "humanAgent")
                );
              };
            } else {
              console.error(`No conference found for callSid: ${callSid} — closing stream`);
              ws.close();
              return;
            }
          }

          console.log("Media stream start:", {
            callSid,
            streamSid,
            conferenceName,
            participantType,
          });

          // Open the transcription session. Provider is OpenAI cloud by default; set
          // CONFERENCE_STT_PROVIDER=speaches for the local turbo Whisper instead.
          transcriber = createConferenceTranscriber({ participantType, onTranscript });

          this.activeStreams.set(callSid, {
            ws,
            transcriber,
            streamSid,
            conferenceName,
            participantType,
          });

          break;

        case "media":
          transcriber?.push(msg.media.payload);
          break;

        case "stop":
          console.log("Media stream stop", callSid);
          transcriber?.close();
          this.activeStreams.delete(callSid);
          break;
      }
    });

    ws.on("close", () => {
      console.log(`${participantType || 'Unknown'} MediaStream WS closed`);
      transcriber?.close();
      if (callSid) this.activeStreams.delete(callSid);
    });

    ws.on("error", (error) => {
      console.error(`MediaStream WS error for ${participantType}:`, error);
    });
  }

  /**
   * Get participant type from active streams
   */
  getParticipantTypeByCallSid(callSid) {
    const streamInfo = this.activeStreams.get(callSid);
    return streamInfo ? streamInfo.participantType : null;
  }
}

module.exports = new TwilioStreamService();