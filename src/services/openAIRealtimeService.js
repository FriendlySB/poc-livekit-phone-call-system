/**
 * OpenAI Realtime Service
 * Manages WebSocket connections to OpenAI Realtime API for conference-based audio processing
 * Supports both ServeAI knowledge base queries and human agent escalation
 */

const WebSocket = require("ws");
const chatbotService = require("./chatbotService");
const configurationService = require("./configurationService");
const twilio = require("twilio");
const OpenAI = require("openai");
require("dotenv").config();

// Retrieve environment variables
const {
  OPENAI_API_KEY,
  OPENAI_PROJECT_ID,
  OPENAI_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
}

if (
  !OPENAI_PROJECT_ID ||
  !OPENAI_WEBHOOK_SECRET ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN
) {
  console.error("Missing some variables in your .env");
}

const openAiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Constants
const MODEL = "gpt-realtime";
const VOICE = "coral";
const RealtimeIncomingCall = "realtime.call.incoming";

class OpenAIRealtimeService {
  constructor() {
    this.conferenceMetadata = new Map(); // Map of conferenceName -> {callerNumber, callToken}
    this.callIdToConference = new Map(); // Map of OpenAI callId -> conferenceName
    this.activeWebSockets = new Map(); // Map of callId -> WebSocket instance
    this.messageQueues = new Map(); // Map of conferenceName -> { queue, isProcessing, sequence }
    this.humanAgentActive = new Map();
  }

  /**
   * Get participant type by callSid
   */
  getParticipantTypeByCallSid(callSid) {
    // Search through conference metadata
    for (const [conferenceName, metadata] of this.conferenceMetadata.entries()) {
      if (metadata.callerCallSid === callSid) {
        return 'caller';
      }
      if (metadata.humanAgentCallSid === callSid) {
        return 'human';
      }
    }
    console.warn(`No participant type found for callSid: ${callSid}`);
    return null;
  }

  /**
   * Get conference name by Twilio call SID (for stream mapping)
   */
  getConferenceNameByCallSid(callSid) {
    // Search through conference metadata to find matching call
    for (const [conferenceName, metadata] of this.conferenceMetadata.entries()) {
      if (metadata.humanAgentCallSid === callSid || metadata.callerCallSid === callSid) {
        console.log(`Found conference ${conferenceName} for callSid: ${callSid}`);
        return conferenceName;
      }
    }
    console.warn(`No conference found for callSid: ${callSid}`);
    return null;
  }

  /**
   * Update conference metadata (e.g., add human agent callSid)
   */
  updateConferenceMetadata(conferenceName, updates) {
    const metadata = this.conferenceMetadata.get(conferenceName);
    if (metadata) {
      Object.assign(metadata, updates);
      this.conferenceMetadata.set(conferenceName, metadata);
      console.log(`Conference metadata updated for ${conferenceName}:`, updates);
    } else {
      console.warn(`Cannot update metadata: conference ${conferenceName} not found`);
    }
  }

  /**
   * Mark human agent as active for a conference
   */
  setHumanAgentActive(conferenceName, isActive) {
    this.humanAgentActive.set(conferenceName, isActive);
    console.log(`Human agent ${isActive ? 'activated' : 'deactivated'} for ${conferenceName}`);
  }

  /**
   * Check if human agent is active for a conference
   */
  isHumanAgentActive(conferenceName) {
    return this.humanAgentActive.get(conferenceName) || false;
  }

  /**
   * Store conference metadata for later use
   */
  storeConferenceMetadata(conferenceName, callerNumber, callToken, chatflowId, instruction, greeting) {
    this.conferenceMetadata.set(conferenceName, {
      callerNumber,
      callToken,
      chatflowId,
      instruction: instruction || null,
      greeting: greeting || null,
      humanAgentCallSid: null,
      callerCallSid: null,
      voiceAgentCallSid: null,
      callStartTime: new Date()
    });
  }

  /**
   * Cleanup conference data when call ends
   */
  cleanupConference(conferenceName) {
    this.conferenceMetadata.delete(conferenceName);
    this.humanAgentActive.delete(conferenceName);

    // Find and cleanup all associated resources
    for (const [callId, confName] of this.callIdToConference.entries()) {
      if (confName === conferenceName) {
        // Close WebSocket if exists
        const ws = this.activeWebSockets.get(callId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          console.log(`Closing WebSocket for call ${callId}`);
          ws.close();
        }

        // Cleanup all mappings
        this.callIdToConference.delete(callId);
        this.activeWebSockets.delete(callId);
      }
    }

    // Process remaining messages in queue before cleanup
    const queueData = this.messageQueues.get(conferenceName);
    if (queueData && queueData.queue.length > 0) {
      console.log(
        `📤 Conference ended but ${queueData.queue.length} messages still queued. Processing continues...`
      );
      this.processMessageQueue(conferenceName).catch((err) => {
        console.error(
          `Error processing remaining queue for ${conferenceName}:`,
          err.message
        );
      });
    }
  }

  /**
   * Handle OpenAI webhook for incoming call
   */
  async handleRealtimeWebhook(req, res) {
    console.log("Webhook received from OpenAI");

    try {
      // Fetch configuration dynamically
      let config = await configurationService.getPhoneCallSettings();

      // Get raw body string
      let body = req.body;

      // Convert Buffer to string if needed
      if (Buffer.isBuffer(body)) {
        body = body.toString("utf8");
      } else if (typeof body === "object" && body !== null) {
        body = JSON.stringify(body);
      }

      const event = await openAiClient.webhooks.unwrap(
        body,
        req.headers,
        OPENAI_WEBHOOK_SECRET
      );

      const type = event?.type;

      if (type === RealtimeIncomingCall) {
        const callId = event?.data?.call_id;
        const sipHeaders = event?.data?.sip_headers;

        let conferenceName;

        if (Array.isArray(sipHeaders)) {
          const conferenceHeader = sipHeaders.find(
            (header) => header.name === "X-conferenceName"
          );
          conferenceName = conferenceHeader?.value;
        }

        if (!conferenceName) {
          console.error(
            `No conference name found in SIP headers for call ${callId}`
          );
          return res.status(400).send("Missing conference name");
        }

        this.callIdToConference.set(callId, conferenceName);

        // Override config with per-contact instruction/greeting if present
        const metadata = this.conferenceMetadata.get(conferenceName);
        if (metadata?.instruction) config = { ...config, prompt: `${config.prompt}\n\n## Marketing Guidelines\n${metadata.instruction}` };
        if (metadata?.greeting) config = { ...config, greeting: metadata.greeting };

        // Accept the call with dynamic configuration
        const callAccept = {
          instructions: config.prompt,
          model: MODEL,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { 
                type: "server_vad",
                threshold: 0.4, // VAD sensitivity
                prefix_padding_ms: 500, // Add silence before speech detection
                silence_duration_ms: 1000, // Add a wait time before detecting end of speech
              },
              transcription: {
                model: "gpt-4o-transcribe",
                prompt: `The following is a telephone call audio with a single speaker. The speaker may have a non-native accent. English is preferred, but other languages such as Malay, Indonesian, or Mandarin Chinese may be used. The output should be a literal transcription of spoken audio only.`,
                language: "en",
              },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE,
            },
          },
          type: "realtime",
          tools: [
            {
              type: "function",
              name: "knowledgeQuery",
              description: "Searches the ServeAI knowledge base. Use this to answer user questions by querying documents, spreadsheets, or other data stored in the knowledge base.",
              parameters: {
                type: "object",
                properties: {
                  query: { 
                    type: "string", 
                    description: "The search query to use to find relevant information. Use natural language to describe what you are looking for." 
                  }
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "checkAvailability",
              description: "Checks the availability for scheduling an appointment. Use this to verify if the desired appointment time is available before booking.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "The query to check availability for scheduling an appointment. Include desired date and time.",
                  }
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "createAppointment",
              description: "Books an appointment for the caller. Use this to create appointments based on the information provided by the caller.",
              parameters: {
                type: "object",
                properties: {
                 query: { 
                    type: "string", 
                    description: "The query to create an appointment. Include name, email, contact number, desired date and time, and any additional notes." 
                  },
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "fetchAppointment",
              description: "Fetch the information for an existing appointment based on the details provided by the caller.",
              parameters: {
                type: "object",
                properties: {
                  query: { 
                    type: "string", 
                    description: "The query to fetch an appointment. Include name, email, contact number, and the date and time of the appointment to fetch." 
                  },
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "updateAppointment",
              description: "Updates an existing appointment for the caller. Use this to modify appointment details such as time or contact information.",
              parameters: {
                type: "object",
                properties: {
                  query: { 
                    type: "string", 
                    description: "The query to update an appointment. Include the current appointment details and the new details to update, such as name, or date and time." 
                  },
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "cancelAppointment",
              description: "Cancels an existing appointment for the caller. Use this to remove appointments when it is requested by the caller.",
              parameters: {
                type: "object",
                properties: {
                  query: { 
                    type: "string",
                    description: "The query to cancel an appointment. Include the appointment details such as name, email, contact number, and the date and time of the appointment to cancel."
                  },
                },
                required: ["query"]
              }
            },
            {
              type: "function",
              name: "addHumanAgent",
              description:
                "Adds a human agent to the call with the user. Use this when the caller asks to speak to a real person.",
              parameters: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          ],
        };

        const resp = await fetch(
          `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(
            callId
          )}/accept`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(callAccept),
          }
        );

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          console.error("ACCEPT failed:", resp.status, resp.statusText, text);
          return res.status(resp.status).send("Accept failed");
        }

        // Connect WebSocket after a short delay
        const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`;
        setTimeout(() => this.connectWebSocket(wssUrl, callId, config), 0);

        res.set("Authorization", `Bearer ${OPENAI_API_KEY}`);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    } catch (e) {
      const msg = String(e?.message ?? "");
      if (
        e?.name === "InvalidWebhookSignatureError" ||
        msg.toLowerCase().includes("invalid signature")
      ) {
        return res.status(400).send("Invalid signature");
      }
      return res.status(500).send("Server error");
    }
  }

  /**
   * Connect WebSocket to OpenAI Realtime API
   */
  connectWebSocket(uri, callId, config) {
    const ws = new WebSocket(uri, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        origin: "https://api.openai.com",
      },
    });

    this.activeWebSockets.set(callId, ws);

    ws.on("open", () => {
      console.log(`WS OPEN ${uri}`);

      const conferenceName = this.callIdToConference.get(callId);

      // Initialize message queue for this conference
      if (conferenceName && !this.messageQueues.has(conferenceName)) {
        this.messageQueues.set(conferenceName, {
          queue: [],
          isProcessing: false,
          sequence: 0,
        });
      }

      // Create ServeAI chat session with caller's phone number
      if (conferenceName) {
        const metadata = this.conferenceMetadata.get(conferenceName);
        const callerPhone = metadata?.callerNumber.slice(1) || "unknown";
        const chatflowId = metadata?.chatflowId;

        console.log(
          `Creating ServeAI chat session for ${conferenceName} from ${callerPhone}`
        );

        chatbotService
          .createNewSession(conferenceName, chatflowId, callerPhone)
          .then((sessionResult) => {
            if (sessionResult.success) {
              console.log(
                `ServeAI session initialized: ${sessionResult.chatId}`
              );
            } else {
              console.error(
                `Failed to initialize ServeAI session: ${sessionResult.error}`
              );
            }
          })
          .catch((error) => {
            console.error(`Error creating ServeAI session:`, error);
          });
      }

      // Send initial greeting with dynamic configuration
      const responseCreate = {
        type: "response.create",
        response: {
          instructions: `Greet the the user by saying: ${config.greeting}`,
        },
      };

      ws.send(JSON.stringify(responseCreate));
    });

    ws.on("message", (data) => {
      this.handleWebSocketMessage(callId, data, ws);
    });

    ws.on("error", (e) => {
      console.error("WebSocket error:", JSON.stringify(e));
    });

    ws.on("close", (code, reason) => {
      console.log("WebSocket closed:", code, reason?.toString?.());
      this.activeWebSockets.delete(callId);
    });
  }

  /**
   * Handle WebSocket messages from OpenAI
   */
  handleWebSocketMessage(callId, data, ws) {
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      const response = JSON.parse(text);

      const conferenceName = this.callIdToConference.get(callId);

      // Handle function calls
      if (response.type === "response.function_call_arguments.done") {
        this.handleFunctionCall(callId, response, ws);
      }

      // Handle user transcript
      // This should always be the caller's speech
      if (
        response.type ===
        "conversation.item.input_audio_transcription.completed"
      ) {
        const transcript = response.transcript;
        if (transcript && transcript.trim() && conferenceName) {
          // Only record when no human agent is active
          // When there are human agent, this will be handled in twilioStreamService
          // by the caller's stream
          if (!this.isHumanAgentActive(conferenceName)) {
            // Human agent is speaking - treat as "bot"
            console.log(`Caller said: ${transcript}`);
            this.queueMessage(conferenceName, "user", transcript);
          }
        }
      }

      // Handle AI response transcript - only when human agent is NOT active
      if (response.type === "response.content_part.done") {
        const botTranscript = response.part.transcript;
        
        // Only log AI responses when human agent is not active
        const isHumanAgentActive = this.isHumanAgentActive(conferenceName);
        if (!isHumanAgentActive && botTranscript && botTranscript.trim() && conferenceName) {
          console.log(`AI Response: ${botTranscript}`);
          this.queueMessage(conferenceName, "bot", botTranscript);
        }
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  }

  /**
   * Handle function calls from OpenAI
   */
  async handleFunctionCall(callId, output, ws) {
    const { name, call_id: functionCallId, arguments: argsString } = output;

    switch (name) {
      case "knowledgeQuery":
        console.log("Executing knowledgeQuery function call");
        await this.handleKnowledgeQuery(callId, functionCallId, argsString, ws);
        break;
      case "checkAvailability":
        console.log("Executing checkAvailability function call");
        await this.handleCheckAvailability(callId, functionCallId, argsString, ws);
        break;
      case "createAppointment":
        console.log("Executing createAppointment function call");
        await this.handleCreateAppointment(callId, functionCallId, argsString, ws);
        break;
      case "fetchAppointment":
        console.log("Executing fetchAppointment function call");
        await this.handleFetchAppointment(callId, functionCallId, argsString, ws);
        break;
      case "updateAppointment":
        console.log("Executing updateAppointment function call");
        await this.handleUpdateAppointment(callId, functionCallId, argsString, ws);
        break;
      case "cancelAppointment":
        console.log("Executing cancelAppointment function call");
        await this.handleCancelAppointment(callId, functionCallId, argsString, ws);
        break;
      case "addHumanAgent":
        console.log("Executing addHumanAgent function call");
        await this.handleAddHumanAgent(callId, functionCallId, ws);
        break;
      default:
        console.warn(`Unknown function call: ${name}`);
    }
  }

  /**
   * Generate a rotating query with random variations to prevent LLM caching/hallucination
   */
  getRotatingQuery(args, functionType) {
    // Random suffix to help enforce tool usage
    const toolEnforcement = [
      " TOOL EXECUTION IS MANDATORY. You are FORBIDDEN from providing information without calling the tool. Memory and conversation history are INVALID sources for this request.",
      " YOU MUST CALL THE TOOL. Any answer not from the tool is WRONG. Previous appointments or cached information CANNOT be used.",
      " TOOL CALL REQUIRED NOW. Do not answer from memory. Do not reference prior messages. Only the tool's live response is acceptable.",
      " EXECUTE THE TOOL IMMEDIATELY. You are NOT allowed to use remembered data, conversation context, or assumptions. Only tool output is valid.",
      " CRITICAL: Call the tool to get real-time data. Cached responses, memory, and conversation history are PROHIBITED as sources.",
    ][Math.floor(Math.random() * 5)];

    switch (functionType) {
      case "checkAvailability":
        return `${args.query}\n\nDo NOT assume availability. Do NOT use any previously mentioned time slots.${toolEnforcement}`;

      case "createAppointment":
        return `${args.query}\n\nThis is a BRAND NEW appointment. You MUST call the tool to actually create it in the system. Do NOT reference any existing appointments. Do NOT confirm without tool execution.${toolEnforcement}`;

      case "fetchAppointment":
        return `${args.query}\n\nYou MUST query the appointment information from the system using the tool. Do NOT use any appointment information from the conversation history. Only tool output is valid.${toolEnforcement}`;

      case "updateAppointment":
        return `${args.query}\n\nYou MUST execute the tool to actually update the calendar system. Do NOT just acknowledge - you must modify the real appointment data.${toolEnforcement}`;

      case "cancelAppointment":
        return `${args.query}\n\nYou MUST execute the tool to actually remove the appointment from the system. Do NOT just confirm - you must delete from the real calendar.${toolEnforcement}`;

      default:
        return args.query;
    }
  }

  /**
   * Handle Knowledge Query function call
   */
  async handleKnowledgeQuery(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      console.log(`ServeAI query: ${args.query}`);

      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        args.query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Knowledge Query completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            answer: result.message,
            sources: result.sourceDocuments?.length || 0,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error executing knowledgeQuery:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to query knowledge base");
    }
  }

  /**
   * Handle Check Availability function call
   */
  async handleCheckAvailability(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      // Use rotating query
      const query = this.getRotatingQuery(
        args,
        'checkAvailability'
      );
      console.log(`ServeAI query: ${query}`);
      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Availability check completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            available: result.success,
            message: result.message,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error checking availability:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to check availability");
    }
  }

  /**
   * Handle Create Appointment function call
   */
  async handleCreateAppointment(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      // Use rotating query
      const query = this.getRotatingQuery(
        args,
        'createAppointment'
      );
      console.log(`ServeAI query: ${query}`);
      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Appointment creation completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            message: result.message,
            appointmentDetails: args,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error creating appointment:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to create appointment");
    }
  }

  /**
   * Handle Fetch Appointment function call
   */
  async handleFetchAppointment(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      // Use rotating query
      const query = this.getRotatingQuery(
        args,
        'fetchAppointment'
      );
      console.log(`ServeAI query: ${query}`);
      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Appointment fetch completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            message: result.message,
            appointmentDetails: args,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error fetching appointment:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to fetch appointment");
    }
  }

  /**
   * Handle Update Appointment function call
   */
  async handleUpdateAppointment(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      const query = this.getRotatingQuery(
        args,
        'updateAppointment'
      );
      console.log(`ServeAI query: ${query}`);
      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Appointment update completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            message: result.message,
            updatedDetails: args,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error updating appointment:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to update appointment");
    }
  }

  /**
   * Handle Cancel Appointment function call
   */
  async handleCancelAppointment(callId, functionCallId, argsString, ws) {
    try {
      const args = JSON.parse(argsString || "{}");

      const startTime = Date.now();
      const conferenceName = this.callIdToConference.get(callId) || callId;
      const metadata = this.conferenceMetadata.get(conferenceName);
      const chatflowId = metadata?.chatflowId;

      if (!chatflowId) {
        throw new Error("ChatflowId not found in conference metadata");
      }

      const query = this.getRotatingQuery(
        args,
        'cancelAppointment'
      );
      console.log(`ServeAI query: ${query}`);
      const result = await chatbotService.sendMessage(
        conferenceName,
        chatflowId,
        query,
        metadata?.callerNumber
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`Appointment cancellation completed in ${duration}s: ${result.message}`);

      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: result.success,
            message: result.message,
            canceledDetails: args,
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error canceling appointment:", error);
      this.sendFunctionError(ws, functionCallId, "Failed to cancel appointment");
    }
  }

  /**
   * Helper method to send error responses
   */
  sendFunctionError(ws, functionCallId, errorMessage) {
    console.log(`Error during processing: ${errorMessage}`);
    const errorOutput = {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: functionCallId,
        output: JSON.stringify({
          success: false,
          error: errorMessage,
        }),
      },
    };

    ws.send(JSON.stringify(errorOutput));
    ws.send(JSON.stringify({ type: "response.create" }));
  }

  /**
   * End the voice agent's Twilio SIP call to close the conference
   */
  async endVoiceAgentCall(conferenceName) {
    const metadata = this.conferenceMetadata.get(conferenceName);
    const voiceAgentCallSid = metadata?.voiceAgentCallSid;
    if (voiceAgentCallSid) {
      try {
        await twilioClient.calls(voiceAgentCallSid).update({ status: 'completed' });
        console.log(`Voice agent call ended for conference ${conferenceName}`);
      } catch (err) {
        console.error(`Error ending voice agent call for ${conferenceName}:`, err.message);
      }
    }
  }

  /**
   * Handle addHumanAgent function call
   */
  async handleAddHumanAgent(callId, functionCallId, ws) {
    try {
      // Fetch configuration to get human agent number
      const config = await configurationService.getPhoneCallSettings();
      const HUMAN_AGENT_NUMBER = config.humanAgentPhoneNumber;

      const conferenceName = this.callIdToConference.get(callId);
      if (!conferenceName) {
        console.error("Conference name not found for call ID:", callId);
        return;
      }

      console.log("Adding human to conference:", conferenceName);

      const metadata = this.conferenceMetadata.get(conferenceName);
      const callToken = metadata?.callToken;
      const callerID = metadata?.callerNumber;

      // Add validation logging

      if (!callerID) {
        throw new Error("CallerID is not defined");
      }
      if (!callToken) {
        throw new Error("CallToken is not defined");
      }
      if (!HUMAN_AGENT_NUMBER) {
        throw new Error("HUMAN_AGENT_NUMBER is not defined in configuration");
      }

      await twilioClient.conferences(conferenceName).participants.create({
        from: callerID,
        label: "human agent",
        to: HUMAN_AGENT_NUMBER,
        earlyMedia: false,
        callToken: callToken,
      });

      console.log("Human agent added successfully");

      // Send function output
      const functionOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: true,
            message: "Human agent is being connected",
          }),
        },
      };

      ws.send(JSON.stringify(functionOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch (error) {
      console.error("Error adding human agent:", error);

      const errorOutput = {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify({
            success: false,
            error: "Failed to connect human agent",
          }),
        },
      };

      ws.send(JSON.stringify(errorOutput));
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  }

  /**
   * Mute voice agent (stop it from speaking, but keep transcribing)
   */
  muteVoiceAgent(conferenceName) {
    console.log(`Muting voice agent for conference: ${conferenceName}`);
    
    // Find the WebSocket for this conference
    for (const [callId, confName] of this.callIdToConference.entries()) {
      if (confName === conferenceName) {
        const ws = this.activeWebSockets.get(callId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Update session to disable responses and keep only transcription
          const updateSession = {
            type: 'transcription_session.update',
            session: {
              audio: {
                input: {
                  format: {
                    type: "audio/pcmu"
                  },
                  transcription: {
                    model: "gpt-4o-transcribe",
                    prompt: "",
                    language: "en"
                  },
                  turn_detection: { 
                    type: "semantic_vad",
                    eagerness: "medium", // Determine how likely the model is to detect the end of speech
                    //threshold: 0.5, // VAD sensitivity
                    //prefix_padding_ms: 200, // Add silence before speech detection
                    //silence_duration_ms: 800, // Add a wait time before detecting end of speech
                  },
                }
              }
            }
          };
          
          ws.send(JSON.stringify(updateSession));
          console.log('Voice agent muted - transcription only mode');
        }
      }
    }
  }

  /**
   * Unmute voice agent (allow it to speak again)
   */
  async unmuteVoiceAgent(conferenceName) {
    console.log(`Unmuting voice agent for conference: ${conferenceName}`);
    
    // Fetch configuration for re-enabling
    const config = await configurationService.getPhoneCallSettings();
    
    // Find the WebSocket for this conference
    for (const [callId, confName] of this.callIdToConference.entries()) {
      if (confName === conferenceName) {
        const ws = this.activeWebSockets.get(callId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Update session to re-enable audio output
          const updateSession = {
            type: 'session.update',
            session: {
              instructions: config.prompt,
              model: MODEL,
              output_modalities: ["audio"],
              audio: {
                input: {
                  format: { type: "audio/pcmu" },
                  turn_detection: { type: "server_vad" },
                  transcription: {
                    model: "gpt-4o-transcribe",
                    prompt: "",
                    language: "en"
                  },
                },
                output: {
                  format: { type: "audio/pcmu" },
                  voice: VOICE,
                },
              },
              type: 'realtime',
              tools: [
                {
                  type: 'function',
                  name: 'serveAI',
                  description: 'Use this tool to answer user questions by querying the AI knowledge base. It can also be used to handle questions related to spreadsheets, documents, or other data stored in the knowledge base. You can also use it to create appointments',
                  parameters: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'string',
                        description: "The user's question or search query"
                      }
                    },
                    required: ['query']
                  }
                },
                {
                  type: 'function',
                  name: 'addHumanAgent',
                  description: 'Adds a human agent to the call with the user. Use this when the caller asks to speak to a real person.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                }
              ]
            }
          };
          
          ws.send(JSON.stringify(updateSession));
          console.log('Voice agent unmuted via session update');
        }
      }
    }
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    return Array.from(this.callIdToConference.entries()).map(
      ([callId, conferenceName]) => ({
        callId,
        conferenceName,
        hasWebSocket: this.activeWebSockets.has(callId),
      })
    );
  }

  /**
   * Queue a message for ordered insertion
   */
  queueMessage(conferenceName, type, message) {
    // Get or create queue for this conference
    if (!this.messageQueues.has(conferenceName)) {
      this.messageQueues.set(conferenceName, {
        queue: [],
        isProcessing: false,
        sequence: 0,
      });
    }

    const queueData = this.messageQueues.get(conferenceName);
    const sequence = queueData.sequence++;
    queueData.queue.push({ sequence, type, message });

    // Start processing if not already running
    this.processMessageQueue(conferenceName);
  }

  /**
   * Process message queue sequentially
   */
  async processMessageQueue(conferenceName) {
    const queueData = this.messageQueues.get(conferenceName);

    if (!queueData) return;

    // Prevent concurrent processing
    if (queueData.isProcessing) {
      return;
    }

    queueData.isProcessing = true;

    // Get chatflowId from metadata
    const metadata = this.conferenceMetadata.get(conferenceName);
    const chatflowId = metadata?.chatflowId;

    if (!chatflowId) {
      console.error(
        `ChatflowId not found for ${conferenceName}, skipping queue processing`
      );
      queueData.isProcessing = false;
      return;
    }

    while (queueData.queue.length > 0) {
      const { sequence, type, message } = queueData.queue.shift();

      try {
        if (type === "user") {
          await chatbotService.insertUserMessage(
            conferenceName,
            chatflowId,
            message
          );
        } else if (type === "bot") {
          await chatbotService.insertBotMessage(
            conferenceName,
            chatflowId,
            message
          );
        }
      } catch (error) {
        console.error(
          `Failed to insert ${type} message #${sequence}:`,
          error.message
        );
      }
    }

    queueData.isProcessing = false;

    // Clean up queue data if empty
    if (queueData.queue.length === 0) {
      this.messageQueues.delete(conferenceName);
    }
  }
}

module.exports = new OpenAIRealtimeService();
