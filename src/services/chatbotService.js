/**
 * Chatbot Service
 * Handles communication with the external chatbot API
 */

const axios = require("axios");
require("dotenv").config();

class ChatbotService {
  constructor() {
    this.serveAiUrl = process.env.SERVE_AI_API_ENDPOINT;
    this.baseUrl = `${process.env.SERVE_AI_API_ENDPOINT}/chatbot`;
    const clientId = process.env.SERVE_AI_CLIENT_ID;
    const clientSecret = process.env.SERVE_AI_CLIENT_SECRET;
    this.basicAuth =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    // Track chat sessions per call
    this.chatSessions = new Map(); // callSid -> chatId
  }

  /**
   * Get or create a chat ID for a call
   */
  async getChatId(callSid, chatflowId, mobile) {
    if (!this.chatSessions.has(callSid)) {
      const result = await this.createNewSession(callSid, chatflowId, mobile);
      if (!result.success) {
        throw new Error(`Failed to create session: ${result.error}`);
      }
    }
    return this.chatSessions.get(callSid);
  }

  /**
   * Send a message to the chatbot and get response
   */
  async sendMessage(callSid, chatflowId, userMessage, callerNumber) {
    try {
      const chatId = await this.getChatId(callSid, chatflowId, callerNumber);

      const response = await axios.post(
        `${this.baseUrl}/prompt/non-streaming`,
        {
          message: userMessage,
          chatId: chatId,
          chatflowId: chatflowId,
          restrictHTML: true,
          callSid: callSid,
        },
        {
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.success) {
        const botMessage = response.data.data.message;
        // Strip HTML tags from the response
        const cleanMessage = this.stripHtmlTags(botMessage);

        return {
          success: true,
          message: cleanMessage,
          sourceDocuments: response.data.data.sourceDocuments || [],
        };
      } else {
        console.error("Chatbot returned unsuccessful response:", response.data);
        return {
          success: false,
          message:
            "I apologize, but I encountered an issue processing your request.",
          error: "Invalid response from chatbot",
        };
      }
    } catch (error) {
      console.error("Error calling chatbot API:", error.message);

      // Return a friendly error message
      return {
        success: false,
        message:
          "I apologize, but I am having trouble connecting to my knowledge base right now. Please try again.",
        error: error.message,
      };
    }
  }

  /**
   * Send message with streaming support
   * @param {Function} onChunk - Callback for each text chunk received
   */
  async sendMessageStreaming(callSid, chatflowId, userMessage, onChunk) {
    try {
      const chatId = await this.getChatId(callSid, chatflowId);

      const response = await axios.post(
        `${this.baseUrl}/prompt`,
        {
          message: userMessage,
          chatId: chatId,
          chatflowId: chatflowId,
          restrictHTML: true,
        },
        {
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json",
          },
          responseType: "stream",
        }
      );

      let fullMessage = "";
      let buffer = "";

      return new Promise((resolve, reject) => {
        response.data.on("data", (chunk) => {
          buffer += chunk.toString();

          // Process complete messages (split by @##@)
          const messages = buffer.split("@##@");
          buffer = messages.pop(); // Keep incomplete message in buffer

          for (const msg of messages) {
            if (!msg.trim()) continue;

            try {
              const parsed = JSON.parse(msg);

              if (parsed.type === "message" && parsed.data) {
                const cleanChunk = this.stripHtmlTags(parsed.data);
                if (cleanChunk) {
                  fullMessage += cleanChunk;
                  // Call the chunk callback with proper spacing
                  if (onChunk) {
                    // Add space if chunk doesn't start with punctuation
                    const needsSpace =
                      fullMessage.length > cleanChunk.length &&
                      !cleanChunk.match(/^[.,!?;:\s]/);
                    onChunk(needsSpace ? " " + cleanChunk : cleanChunk);
                  }
                }
              }
            } catch (e) {
              // Skip malformed JSON
            }
          }
        });

        response.data.on("end", () => {
          console.log("Stream completed. Full message:", fullMessage);
          resolve({
            success: true,
            message: fullMessage,
            sourceDocuments: [],
          });
        });

        response.data.on("error", (error) => {
          console.error("Stream error:", error);
          reject(error);
        });
      });
    } catch (error) {
      console.error("Error calling streaming chatbot API:", error.message);
      return {
        success: false,
        message:
          "I apologize, but I am having trouble connecting to my knowledge base right now. Please try again.",
        error: error.message,
      };
    }
  }

  /**
   * Strip HTML tags from text
   */
  stripHtmlTags(html) {
    if (!html) return "";

    let text = html.replace(/<[^>]*>/g, "");

    text = text
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return text.trim();
  }

  /**
   * Clear chat session for a call
   */
  clearSession(callSid) {
    if (this.chatSessions.has(callSid)) {
      console.log(`Cleared chat session for call ${callSid}`);
      this.chatSessions.delete(callSid);
    }
  }

  /**
   * Get active chat sessions
   */
  getActiveSessions() {
    return Array.from(this.chatSessions.entries()).map(([callSid, chatId]) => ({
      callSid,
      chatId,
    }));
  }

  /**
   * Check if a new chatroom version should be created based on time rules
   * Rules:
   * - Session expires at midnight (00:00) in Malaysia Time (UTC+8)
   * - 2-hour grace period: if last activity was within 2 hours, keep session active
   * @param {object} chatRoom - Existing chatroom
   * @returns {boolean} True if new version should be created
   */
  shouldCreateNewVersionByTime(chatRoom) {
    if (!chatRoom || !chatRoom.lastChatDate) {
      return false; // No existing chatroom, let normal creation logic handle it
    }

    // If chatroom has the flag isOutdated = true, then always create new version
    if (chatRoom.isOutdated) {
      return true;
    }

    const now = new Date();
    const lastChatDate = new Date(chatRoom.lastChatDate);
    const createdAt = new Date(chatRoom.createdAt);

    // Convert to Malaysia Time (UTC+8)
    const MALAYSIA_TIME_OFFSET = 8 * 60; // 8 hours in minutes
    const nowMYT = new Date(now.getTime() + MALAYSIA_TIME_OFFSET * 60 * 1000);
    const createdAtMYT = new Date(createdAt.getTime() + MALAYSIA_TIME_OFFSET * 60 * 1000);

    // Get date strings in YYYY-MM-DD format for Malaysia Time
    const nowDateMYT = nowMYT.toISOString().split("T")[0];
    const createdDateMYT = createdAtMYT.toISOString().split("T")[0];

    // Check if we're on a different day in Malaysia Time
    const isDifferentDay = nowDateMYT !== createdDateMYT;

    // Calculate hours since last chat (in UTC, no timezone conversion needed)
    const hoursSinceLastChat = (now - lastChatDate) / (1000 * 60 * 60);

    // If same day in Malaysia Time, always use existing chatroom
    if (!isDifferentDay) {
      return false;
    }

    // Different day - check grace period
    // If more than 2 hours since last chat, create new version
    if (hoursSinceLastChat > 2) {
      return true;
    }

    return false;
  }

  /**
   * Create a new chat session with the chatbot API
   * @param {string} callSid - The Twilio call SID
   * @param {string} chatflowId - The chatflow ID
   * @param {string} mobile - The caller's phone number
   * @returns {Promise<object>} - Session creation response
   */
  async createNewSession(callSid, chatflowId, mobile) {
    try {
      // Try to fetch the latest session first from the database
      // Fetch latest chatroom for this phone number
      const latestChatroom = await axios.get(
        `${this.baseUrl}/chatroom/${chatflowId}`,
        {
          params: {
            channel: "phoneCall",
            mobile: mobile,
          },
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json"
          }
        }
      );

      // Check if we need to create a new version based on time rules
      const needNewVersion = this.shouldCreateNewVersionByTime(latestChatroom.data.data);

      // If there is an existing session, and no need for new version, then reuse it
      if (latestChatroom.data.data && latestChatroom.data.success && !needNewVersion) {
        const chatId = latestChatroom.data.data.chatId;
        // Store the chat ID for this call
        this.chatSessions.set(callSid, chatId);
        console.log(`Retrieved existing chat session for call ${callSid}: ${chatId}`);

        return {
          success: true,
          chatId: chatId,
          data: latestChatroom.data.data,
        };
      }

      // If none found, then call the chatbot API to create a new session
      const response = await axios.post(
        `${this.baseUrl}/version/${chatflowId}`,
        {
          channel: "phoneCall",
          mobile: mobile,
        },
        {
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.success) {
        const chatId = response.data.data.chatId;
        // Store the new chat ID for this call
        this.chatSessions.set(callSid, chatId);

        console.log(`Created new chat session for call ${callSid}: ${chatId}`);

        return {
          success: true,
          chatId: chatId,
          data: response.data.data,
        };
      } else {
        console.error("Failed to create new session:", response.data);
        return {
          success: false,
          error: "Failed to create session",
        };
      }
    } catch (error) {
      console.error("Error creating new session:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Insert user message (from Twilio/caller) into chat history
   * @param {string} callSid - The Twilio call SID
   * @param {string} chatflowId - The chatflow ID
   * @param {string} userMessage - The user's message text
   * @returns {Promise<object>} - Insert result
   */
  async insertUserMessage(callSid, chatflowId, userMessage, elevenLabsConversationId, callName, callStartFormatted, callEndFormatted) {
    try {
      const chatId = await this.getChatId(callSid, chatflowId);

      const response = await axios.post(
        `${this.baseUrl}/send/${chatflowId}`,
        {
          message: userMessage,
          chatId: chatId,
          elevenLabsConversationId: elevenLabsConversationId,
          callName: callName,
          callStartTime: callStartFormatted,
          callEndTime: callEndFormatted,
        },
        {
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.success) {
        return {
          success: true,
          data: response.data.data,
        };
      } else {
        console.error("Failed to insert user message:", response.data);
        return {
          success: false,
          error: "Failed to insert user message",
        };
      }
    } catch (error) {
      console.error("Error inserting user message:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Insert bot message (from OpenAI) into chat history
   * @param {string} callSid - The Twilio call SID
   * @param {string} chatflowId - The chatflow ID
   * @param {string} botMessage - The bot's message text
   * @returns {Promise<object>} - Insert result
   */
  async insertBotMessage(callSid, chatflowId, botMessage, elevenLabsConversationId, callName, callStartFormatted, callEndFormatted) {
    try {
      const chatId = await this.getChatId(callSid, chatflowId);

      const response = await axios.post(
        `${this.baseUrl}/insert-bot-message`,
        {
          message: botMessage,
          chatId: chatId,
          channel: "phoneCall",
          elevenLabsConversationId: elevenLabsConversationId,
          callName: callName,
          callStartTime: callStartFormatted,
          callEndTime: callEndFormatted,
        },
        {
          headers: {
            Authorization: this.basicAuth,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.success) {
        return {
          success: true,
          data: response.data.data,
        };
      } else {
        console.error("Failed to insert bot message:", response.data);
        return {
          success: false,
          error: "Failed to insert bot message",
        };
      }
    } catch (error) {
      console.error("Error inserting bot message:", error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = new ChatbotService();
