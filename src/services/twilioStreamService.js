const WebSocket = require("ws");
const openAIRealtimeService = require("./openAIRealtimeService");
const elevenLabsService = require("./elevenLabsService");

class TwilioStreamService {
  constructor() {
    this.activeStreams = new Map(); // callSid -> { ws, openAiWs, streamSid, participantType, conferenceName }
  }

  /**
   * Handle new Twilio Media Stream WS connection
   */
  handleConnection(ws, req) {
    console.log("Twilio media stream connected");

    let callSid = null;
    let streamSid = null;
    let openAiWs = null;
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
            if (elevenLabsParticipant) {
              conferenceName = elevenLabsParticipant.conferenceName;
              participantType = elevenLabsParticipant.participantType;
              const { conversationId } = elevenLabsParticipant;
              onTranscript = (messageType, transcript) => {
                elevenLabsService.insertHumanConferenceMessage(conversationId, participantType, transcript)
                  .catch(err => console.error(`Human conference insert error for ${conversationId}:`, err.message));
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

          // Create OpenAI Realtime transcription session
          openAiWs = await this.createRealtimeTranscriber(callSid, conferenceName, participantType, onTranscript);

          this.activeStreams.set(callSid, {
            ws,
            openAiWs,
            streamSid,
            conferenceName,
            participantType,
          });

          break;

        case "media":
          if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;

          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          };

          openAiWs.send(JSON.stringify(audioAppend));
          break;

        case "stop":
          console.log("Media stream stop", callSid);
          if (openAiWs) openAiWs.close();
          this.activeStreams.delete(callSid);
          break;
      }
    });

    ws.on("close", () => {
      console.log(`${participantType || 'Unknown'} MediaStream WS closed`);
      if (openAiWs) openAiWs.close();
      if (callSid) this.activeStreams.delete(callSid);
    });

    ws.on("error", (error) => {
      console.error(`MediaStream WS error for ${participantType}:`, error);
    });
  }

  /**
   * Create a Realtime session for transcription-only
   */
  async createRealtimeTranscriber(callSid, conferenceName, participantType, onTranscript) {
    const wsUrl = `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini`;

    const openAiWs = new WebSocket(wsUrl, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      }
    });

    openAiWs.on("open", () => {
      console.log(`OpenAI transcription WebSocket connected for ${participantType}`);

      const sessionConfig = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          output_modalities: ["text"],
          audio: {
            input: {
              format: { 
                type: "audio/pcmu" 
              },
              turn_detection: { 
                type: "server_vad",
                //eagerness: "medium", // Determine how likely the model is to detect the end of speech
                threshold: 0.5, // VAD sensitivity
                prefix_padding_ms: 300, // Add silence before speech detection
                silence_duration_ms: 500, // Add a wait time before detecting end of speech
              },
              transcription: {
                model: "gpt-4o-transcribe",
                prompt: "Transcribe the following audio message. Ensure that you transcribe in the exact same language as spoken in the audio. Do not translate or interpret the content, just provide a verbatim transcription.",
                language: "en"
              },
            },
          },
        }
      };

      openAiWs.send(JSON.stringify(sessionConfig));
    });

    openAiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const transcript = msg.transcript;
          
          if (!transcript || !transcript.trim()) return;

          // Determine message type based on participant
          const messageType = participantType === 'caller' ? 'user' : 'humanAgent';
          
          console.log(`${participantType === 'caller' ? 'Caller' : 'Human Agent'} said: ${transcript}`);
          
          if (onTranscript) {
            onTranscript(messageType, transcript);
          }
        }

      } catch (e) {
        console.error("Error processing OpenAI message:", e);
      }
    });

    openAiWs.on("close", () => {
      console.log(`OpenAI transcription WebSocket closed for ${participantType}`);
    });
    
    openAiWs.on("error", (err) => {
      console.error(`OpenAI WS error for ${participantType}:`, err);
    });

    return openAiWs;
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