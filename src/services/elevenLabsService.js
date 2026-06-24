/**
 * ElevenLabs Service
 * Manages ElevenLabs Conversational AI agent registration for phone calls
 */

const axios = require("axios");
const twilio = require("twilio");
const chatbotService = require("./chatbotService");
require("dotenv").config();

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";

class ElevenLabsService {
  constructor() {
    this.conversationMetadata = new Map(); // conversationId -> { callSid, callerNumber, chatflowId, twilioNumber, ... }
    this.callSidToConversation = new Map(); // callSid -> conversationId
    this.pendingTransfers = new Map();      // outboundCallSid -> { resolve, conferenceName, conversationId }
    this.transferParticipants = new Map(); // callSid -> { conversationId, participantType, conferenceName }

    this.twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  /**
   * Register a Twilio call with ElevenLabs and return the TwiML to pass back to Twilio.
   * ElevenLabs returns a TwiML string directly — ServeAI is out of the audio path after this.
   * Note: The SDK (v1.59.0) does not expose register-call for inbound calls, so we use
   * axios to call POST /v1/convai/twilio/register-call directly.
   * @param {string} callerNumber - The caller's phone number (e.g. "+60123456789")
   * @param {string} twilioNumber - The Twilio number that received the call (e.g. "+60393880432")
   * @param {object} config - Phone call config from configurationService (prompt, greeting, chatflowId, elevenLabsAgentId)
   * @returns {Promise<{ twiml: string, conversationId: string|null }>}
   */
  async registerCall(callerNumber, twilioNumber, config) {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY");
    if (!config.elevenLabsAgentId) throw new Error("Missing ElevenLabs agent ID in configuration");

    console.log(`Registering ElevenLabs call for ${callerNumber} to ${twilioNumber}`);

    const response = await axios.post(
      `${ELEVENLABS_API_BASE}/v1/convai/twilio/register-call`,
      {
        agent_id: config.elevenLabsAgentId,
        from_number: callerNumber,
        to_number: twilioNumber,
        direction: "inbound",
        conversation_initiation_client_data: {
          conversation_config_override: {
            agent: {
              prompt: { prompt: config.prompt || "" },
              first_message: config.greeting || "",
              language: config.language || "en", // Default to English if not specified in config
            },
          },
          dynamic_variables: {
            caller_number: callerNumber,
            chatflow_id: config.chatflowId || "",
          },
        },
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        responseType: "text", // ElevenLabs returns raw TwiML, not JSON
      }
    );

    const twiml = response.data;

    // Extract conversation_id embedded in the returned TwiML
    // ElevenLabs uses snake_case: <Parameter name="conversation_id" value="conv_xxx" />
    const conversationId = twiml.match(/name="conversation_id" value="([^"]+)"/)?.[1] ?? null;

    if (conversationId) {
      console.log(`ElevenLabs conversation registered: ${conversationId}`);
    } else {
      console.warn("Could not extract conversation_id from ElevenLabs TwiML response");
    }

    return { twiml, conversationId };
  }

  /**
   * Store conversation metadata after a successful registerCall
   * @param {string} conversationId
   * @param {string} callSid - Twilio CallSid of the caller's call leg
   * @param {string} callerNumber
   * @param {string|null} chatflowId
   * @param {string|null} twilioNumber - The Twilio number that received the call (without +)
   * @param {string|null} humanAgentPhoneNumber - From DB config
   * @param {number|null} humanAgentTimeout - Transfer delay in ms from DB config
   */
  storeConversationMetadata(conversationId, callSid, callerNumber, chatflowId, twilioNumber, humanAgentPhoneNumber, humanAgentTimeout) {
    this.conversationMetadata.set(conversationId, {
      callSid,
      callerNumber,
      chatflowId: chatflowId || null,
      twilioNumber: twilioNumber || null,
      humanAgentPhoneNumber: humanAgentPhoneNumber || null,
      humanAgentTimeout: humanAgentTimeout || null,
      transferConferenceName: null,
      humanAgentCallSid: null,
      agentTranscriptInserted: false,
      humanConferenceBuffer: [],
    });

    if (callSid) {
      this.callSidToConversation.set(callSid, conversationId);
    }
  }

  /**
   * Reverse-lookup conversation ID from a Twilio CallSid
   * @param {string} callSid
   * @returns {string|null}
   */
  getConversationIdByCallSid(callSid) {
    return this.callSidToConversation.get(callSid) ?? null;
  }

  /**
   * Resolve a pending human-agent transfer when Twilio fires a status callback
   * for the outbound call leg (answered / completed / failed etc.).
   * Called from elevenLabsController.handleTransferStatus.
   * @param {string} outboundCallSid
   * @param {string} callStatus - Twilio CallStatus value
   */
  resolveTransfer(outboundCallSid, callStatus) {
    const pending = this.pendingTransfers.get(outboundCallSid);
    if (!pending) {
      // "canceled" — we self-canceled after timeout, entry already deleted
      // "completed" — fires when human agent hangs up after the call was already answered and entry was removed
      if (callStatus === "completed") {
        console.log(`resolveTransfer: human agent call ${outboundCallSid} ended after transfer was already established`);
      } else if (callStatus !== "canceled") {
        console.warn(`resolveTransfer: unexpected status "${callStatus}" for unknown SID ${outboundCallSid}`);
      }
      return;
    }

    if (callStatus === "ringing") {
      console.log(`addHumanAgent: call is ringing on device for conversation ${pending.conversationId}`);
      return; // keep waiting
    }

    if (["answered", "in-progress"].includes(callStatus)) {
      // Store the human agent call SID in the conversation metadata for the transfer conference
      const meta = this.conversationMetadata.get(pending.conversationId);
      if (meta) meta.humanAgentCallSid = outboundCallSid;

      pending.resolve("answered");
      this.pendingTransfers.delete(outboundCallSid);
    } else if (["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus)) {
      pending.resolve(callStatus === "completed" ? "failed" : callStatus);
      this.pendingTransfers.delete(outboundCallSid);
    }
    // ignore transitional states (initiated, queued)
  }

  /**
   * Retrieve stored metadata for a conversation
   * @param {string} conversationId
   * @returns {object|null}
   */
  getConversationMetadata(conversationId) {
    return this.conversationMetadata.get(conversationId) ?? null;
  }

  /**
   * Remove all in-memory state for a completed conversation
   * @param {string} conversationId
   */
  cleanupConversation(conversationId) {
    const metadata = this.conversationMetadata.get(conversationId);
    if (metadata?.callSid) {
      this.callSidToConversation.delete(metadata.callSid);
    }
    // Clean up any transfer participants for this conversation
    for (const [sid, info] of this.transferParticipants.entries()) {
      if (info.conversationId === conversationId) {
        this.transferParticipants.delete(sid);
      }
    }
    this.conversationMetadata.delete(conversationId);
    console.log(`Cleaned up ElevenLabs conversation ${conversationId}`);
  }

  /**
   * Store a transfer conference participant for media stream lookup.
   * Called from _handleAddHumanAgent after the caller is redirected into the conference.
   */
  storeTransferParticipant(callSid, conversationId, participantType, conferenceName) {
    this.transferParticipants.set(callSid, { conversationId, participantType, conferenceName });
    console.log(`Transfer conference: stored ${participantType} participant ${callSid} for conversation ${conversationId}`);
  }

  /**
   * Look up a transfer conference participant for media stream routing (used by twilioStreamService).
   * @returns {{ conversationId, participantType, conferenceName }|null}
   */
  getTransferParticipant(callSid) {
    return this.transferParticipants.get(callSid) ?? null;
  }

  /**
   * Buffer or directly insert a human agent conference transcript message.
   * Messages are buffered until the ElevenLabs agent transcript has finished inserting
   * to preserve correct ordering in the chatroom.
   * @param {string} conversationId
   * @param {string} participantType - "caller" | "human-agent"
   * @param {string} transcript
   */
  async insertHumanConferenceMessage(conversationId, participantType, transcript) {
    const meta = this.conversationMetadata.get(conversationId);
    if (!meta) {
      console.warn(`insertHumanConferenceMessage: no metadata for ${conversationId} — message dropped`);
      return;
    }
    if (!meta.agentTranscriptInserted) {
      // Agent transcript insert is still in progress; buffer the message
      meta.humanConferenceBuffer.push({ participantType, message: transcript });
      return;
    }
    // Agent transcript already inserted — write directly
    await this._insertHumanConferenceMessageDirect(meta, participantType, transcript);
  }

  async _insertHumanConferenceMessageDirect(meta, participantType, transcript) {
    const { callSid, chatflowId } = meta;
    try {
      if (participantType === "caller") {
        await chatbotService.insertUserMessage(callSid, chatflowId, transcript);
      } else {
        await chatbotService.insertBotMessage(callSid, chatflowId, transcript, "humanAgent");
      }
    } catch (err) {
      console.error(`Human conference insert error [${participantType}]:`, err.message);
    }
  }

  /**
   * Final cleanup after human agent conference ends.
   * Called from handleTransferConferenceEvents on conference-end.
   * @param {string} conversationId
   */
  cleanupAfterHumanConferenceEnd(conversationId) {
    const meta = this.conversationMetadata.get(conversationId);
    const callSid = meta?.callSid;
    console.log(`Human agent conference cleanup for conversation ${conversationId}`);
    this.cleanupConversation(conversationId);
    if (callSid) chatbotService.clearSession(callSid);
  }

  /**
   * Return all active conversations (used for health check / debug)
   * @returns {Array<{ conversationId, callSid, callerNumber }>}
   */
  getActiveSessions() {
    return Array.from(this.conversationMetadata.entries()).map(
      ([conversationId, meta]) => ({
        conversationId,
        callSid: meta.callSid,
        callerNumber: meta.callerNumber,
      })
    );
  }

  // Tool webhook handling

  /**
   * Entry point for all ElevenLabs tool webhooks.
   * Dispatches to the per-tool handler. Each handler sends the HTTP response itself.
   *
   * ElevenLabs request body: { conversationId: "conv_xxx", ...toolParams }
   * ElevenLabs expects back: { result: "<string>" } on success, { error: "..." } on failure
   */
  async handleToolWebhook(toolName, req, res) {

    const { conversationId, ...parameters } = req.body;

    console.log(`ElevenLabs tool webhook: ${toolName}`);
    
    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }

    const metadata = this.conversationMetadata.get(conversationId);
    if (!metadata) {
      console.warn(`No metadata for conversation ${conversationId}`);
      return res.status(404).json({ error: "Conversation not found" });
    }

    try {
      await this._dispatchTool(toolName, conversationId, metadata, parameters, res);
    } catch (error) {
      if (!res.headersSent) {
        console.error(`Tool ${toolName} error:`, error.message);
        res.json({ error: error.message });
      }
    }
  }

  /**
   * Route to the correct per-tool handler
   */
  async _dispatchTool(toolName, conversationId, metadata, parameters, res) {
    switch (toolName) {
      case "serveAI":
        return this._handleServeAITool(conversationId, metadata, parameters, res);
      case "knowledgeQuery":
        return this._handleKnowledgeQuery(conversationId, metadata, parameters, res);
      case "checkAvailability":
        return this._handleCheckAvailability(conversationId, metadata, parameters, res);
      case "createAppointment":
        return this._handleCreateAppointment(conversationId, metadata, parameters, res);
      case "fetchAppointment":
        return this._handleFetchAppointment(conversationId, metadata, parameters, res);
      case "updateAppointment":
        return this._handleUpdateAppointment(conversationId, metadata, parameters, res);
      case "cancelAppointment":
        return this._handleCancelAppointment(conversationId, metadata, parameters, res);
      case "addHumanAgent":
        return this._handleAddHumanAgent(conversationId, metadata, parameters, res);
      default:
        console.warn(`Unknown ElevenLabs tool: ${toolName}`);
        res.json({ error: `Unknown tool: ${toolName}` });
    }
  }

  /**
   * Execute a chatbot query and return the result to ElevenLabs.
   * Shared helper used by all appointment / knowledge tools.
   */
  async _executeChatbotQuery(toolName, conversationId, metadata, query, res) {
    const { callSid, chatflowId, callerNumber } = metadata;

    if (!chatflowId) throw new Error("chatflowId not found in conversation metadata");

    const startTime = Date.now();
    console.log(`[${toolName}] ServeAI query: ${query}`);

    const result = await chatbotService.sendMessage(callSid, chatflowId, query, callerNumber);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${toolName}] Completed in ${duration}s: ${result.message}`);

    res.json({ result: result.message });
  }

  /**
   * Generate a rotating query with random anti-cache variations.
   * Mirrors the same logic used in openAIRealtimeService.
   */
  _getRotatingQuery(args, functionType) {
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

  async _handleServeAITool(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "serveAI");
    return this._executeChatbotQuery(
      "serveAI",
      conversationId,
      metadata,
      parameters.query,
      res
    );
  }

  async _handleKnowledgeQuery(conversationId, metadata, parameters, res) {
    return this._executeChatbotQuery(
      "knowledgeQuery",
      conversationId,
      metadata,
      parameters.query,
      res
    );
  }

  async _handleCheckAvailability(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "checkAvailability");
    return this._executeChatbotQuery("checkAvailability", conversationId, metadata, query, res);
  }

  async _handleCreateAppointment(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "createAppointment");
    return this._executeChatbotQuery("createAppointment", conversationId, metadata, query, res);
  }

  async _handleFetchAppointment(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "fetchAppointment");
    return this._executeChatbotQuery("fetchAppointment", conversationId, metadata, query, res);
  }

  async _handleUpdateAppointment(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "updateAppointment");
    return this._executeChatbotQuery("updateAppointment", conversationId, metadata, query, res);
  }

  async _handleCancelAppointment(conversationId, metadata, parameters, res) {
    const query = this._getRotatingQuery(parameters, "cancelAppointment");
    return this._executeChatbotQuery("cancelAppointment", conversationId, metadata, query, res);
  }

  async _handleAddHumanAgent(conversationId, metadata, parameters, res) {
    const { callSid, twilioNumber, humanAgentPhoneNumber, humanAgentTimeout } = metadata;
    const host = process.env.HOST;

    if (!humanAgentPhoneNumber) {
      console.error(`addHumanAgent: no humanAgentPhoneNumber configured for conversation ${conversationId}`);
      return res.json({ result: "failed" });
    }

    if (!twilioNumber) {
      console.error(`addHumanAgent: no twilioNumber stored for conversation ${conversationId}`);
      return res.json({ result: "failed" });
    }

    const conferenceName = `transfer_${conversationId}`;
    const fromNumber = `+${twilioNumber}`;
    const toNumber = humanAgentPhoneNumber.startsWith("+") ? humanAgentPhoneNumber : `+${humanAgentPhoneNumber}`;

    const twilioClient = this.twilioClient;

    // Human agent joins a waiting conference (startConferenceOnEnter=false so they wait)
    const humanAgentTwiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Dial>` +
      `<Conference participantLabel="human agent" startConferenceOnEnter="false" waitUrl="" beep="false">${conferenceName}</Conference>` +
      `</Dial></Response>`;

    // Deferred promise — resolved by resolveTransfer() when status callback fires
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
        statusCallback: `https://${host}/api/phone-call/elevenlabs/transfer-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      });
      outboundCallSid = call.sid;

      this.pendingTransfers.set(outboundCallSid, {
        resolve: resolveDeferred,
        conferenceName,
        conversationId,
      });

      const meta = this.conversationMetadata.get(conversationId);
      if (meta) meta.transferConferenceName = conferenceName;

      console.log(
        `addHumanAgent: dialing ${toNumber} from ${fromNumber}, outbound SID: ${outboundCallSid}`
      );
    } catch (err) {
      console.error("addHumanAgent: failed to create outbound call:", err.message);
      return res.json({ result: "failed" });
    }

    // Wait for human agent to answer — bound by the configured timeout (ElevenLabs gives 45s for this tool)
    const answerTimeoutMs = humanAgentTimeout * 1000 || 40000;
    console.log(`addHumanAgent: waiting up to ${answerTimeoutMs}ms for ${toNumber} to answer (outbound SID: ${outboundCallSid})`);
    const result = await Promise.race([
      waitForAnswer,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), answerTimeoutMs)),
    ]);

    if (result === "answered") {
      console.log(`addHumanAgent: human agent answered for conversation ${conversationId}. Redirecting caller immediately.`);

      // Respond to ElevenLabs immediately — this ends the ElevenLabs stream
      res.json({ success: true, result: "Call transferred successfully to the human agent" });

      // Build caller TwiML — redirects caller out of ElevenLabs <Connect><Stream>
      // and into the waiting transfer conference where the human agent already is.
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
        console.log(`addHumanAgent: caller ${callSid} redirected to conference ${conferenceName}`);
      } catch (err) {
        console.error("addHumanAgent: failed to redirect caller:", err.message);
        return;
      }

      // Register both participants so twilioStreamService can look them up by callSid
      this.storeTransferParticipant(callSid, conversationId, "caller", conferenceName);
      this.storeTransferParticipant(outboundCallSid, conversationId, "human-agent", conferenceName);

      // Start media streams on both call legs for human conference transcription
      const startStream = async (sid, label) => {
        try {
          await twilioClient.calls(sid).streams.create({
            url: `wss://${host}/api/twilio/media-stream`,
            track: "inbound_track",
            statusCallback: `https://${host}/api/twilio/stream-status`,
          });
          console.log(`Transfer conference: started media stream for ${label} (${sid})`);
        } catch (err) {
          console.error(`Transfer conference: failed to start media stream for ${label} (${sid}):`, err.message);
        }
      };

      await Promise.all([
        startStream(callSid, "caller"),
        startStream(outboundCallSid, "human-agent"),
      ]);

      return;
    }

    // timeout or call failed — cancel the outbound call
    this.pendingTransfers.delete(outboundCallSid);
    try {
      await twilioClient.calls(outboundCallSid).update({ status: "completed" });
    } catch { /* already ended */ }

    const reason = result === "timeout" ? "No answer from the human agent" : "failed";
    console.log(`addHumanAgent: transfer ${reason} for conversation ${conversationId}`);
    return res.json({ success: false, result: reason });
  }

  // Post-call transcript insertion

  /**
   * Insert the full post-call transcript into the chatroom (ServeAI chat history).
   * Called from the post-call webhook handler after ElevenLabs delivers the transcript.
   *
   * Messages are inserted sequentially (one at a time) to preserve ordering.
   * The chatId is resolved before the loop so all inserts share the same session.
   *
   * Metadata fallback order:
   *   1. In-memory conversationMetadata (populated at call start)
   *   2. conversation_initiation_client_data.dynamic_variables in the webhook payload
   *
   * @param {object} event - Full ElevenLabs post-call conversation object
   */
  async processTranscript(event) {
    const conversationId = event.conversation_id;
    const transcript = event.transcript;

    if (!conversationId) {
      console.warn("processTranscript: missing conversation_id");
      return;
    }

    if (!Array.isArray(transcript) || transcript.length === 0) {
      console.log(`processTranscript: no transcript entries for ${conversationId}`);
      return;
    }

    // Resolve callSid, chatflowId, callerNumber — prefer stored metadata, fall back to event
    let callSid, chatflowId, callerNumber;
    const stored = this.conversationMetadata.get(conversationId);

    if (stored) {
      ({ callSid, chatflowId, callerNumber } = stored);
    } else {
      // Webhook may arrive after server restart — extract from event payload
      const dynVars = event.conversation_initiation_client_data?.dynamic_variables;
      chatflowId = dynVars?.chatflow_id;
      callerNumber = dynVars?.caller_number || event.metadata?.phone_call?.external_number;
      // call_sid in the ElevenLabs payload is sometimes blank for inbound calls via register-call
      // Fall back to conversation_id as the session key so chatbotService can still create a chatroom
      const rawCallSid = event.metadata?.phone_call?.call_sid;
      callSid = rawCallSid && rawCallSid.length > 0 ? rawCallSid : conversationId;
      console.warn(
        `processTranscript: no stored metadata for ${conversationId}, using event fallback (callSid: ${callSid})`
      );
    }

    if (!chatflowId) {
      console.error(`processTranscript: cannot insert transcript for ${conversationId} — no chatflowId`);
      return;
    }

    // Ensure the chatId exists in chatbotService before inserting.
    // getChatId creates a new session if one doesn't exist for this callSid.
    try {
      await chatbotService.getChatId(callSid, chatflowId, callerNumber);
    } catch (err) {
      console.error(
        `processTranscript: failed to get/create chatId for ${conversationId}:`,
        err.message
      );
      return;
    }

    // Filter out empty turns before inserting
    const turns = transcript.filter((t) => t.message && t.message.trim().length > 0);

    console.log(
      `processTranscript: inserting ${turns.length} messages for conversation ${conversationId} (callSid: ${callSid})`
    );

    let inserted = 0;
    let failed = 0;

    // Prepare metadata for the chat messages: use stored values if available, otherwise fall back to event data or sensible defaults.
    const callName = event.analysis?.call_summary_title || "Call with " + (callerNumber || "unknown number");
    const callStartDate = stored?.callStartTime || new Date();
    const durationSecs = event.metadata?.call_duration_secs || 0;
    const callEndDate = new Date(callStartDate.getTime() + durationSecs * 1000);
    const callStartFormatted = this.formatTimestamp(callStartDate);
    const callEndFormatted = this.formatTimestamp(callEndDate);

    for (const turn of turns) {
      const { role, message } = turn;

      // Strip messages from [tags] tags
      const cleanedMessage = message.replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, " ")  // collapse multiple spaces
      .trim();
      
      try {
        if (role === "user") {
          await chatbotService.insertUserMessage(callSid, chatflowId, cleanedMessage, conversationId, callName, callStartFormatted, callEndFormatted);
        } else if (role === "agent") {
          await chatbotService.insertBotMessage(callSid, chatflowId, cleanedMessage, conversationId, callName, callStartFormatted, callEndFormatted);
        } else {
          continue;
        }
        inserted++;
      } catch (err) {
        console.error(`processTranscript: failed to insert ${role} message:`, err.message);
        failed++;
      }
    }

    console.log(
      `processTranscript: complete for ${conversationId} — ${inserted} inserted, ${failed} failed`
    );

    // Mark agent transcript as inserted and flush any human conference messages buffered during insert
    const liveMeta = this.conversationMetadata.get(conversationId);
    if (liveMeta) {
      liveMeta.agentTranscriptInserted = true;
      const buffered = liveMeta.humanConferenceBuffer.splice(0);
      if (buffered.length > 0) {
        console.log(`processTranscript: flushing ${buffered.length} buffered human conference messages for ${conversationId}`);
        for (const { participantType, message: msg } of buffered) {
          await this._insertHumanConferenceMessageDirect(liveMeta, participantType, msg);
        }
      }
    }

    // If no human agent transfer was initiated, clean up immediately.
    // If a transfer is active, cleanup happens in cleanupAfterHumanConferenceEnd() when the conference ends.
    if (!liveMeta?.transferConferenceName) {
      this.cleanupConversation(conversationId);
      chatbotService.clearSession(callSid);
    } else {
      console.log(`processTranscript: agent transcript inserted for ${conversationId}, keeping metadata alive for ongoing human conference`);
    }
  }

  formatTimestamp(date) {
    const y  = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const d  = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${y}-${mo}-${d} ${hh}:${mm}:${ss}`;
  }
}

module.exports = new ElevenLabsService();
