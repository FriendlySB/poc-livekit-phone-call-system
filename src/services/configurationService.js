/**
 * Configuration Service
 * Handles fetching dynamic configurations from ServeAI API
 */

const axios = require("axios");
require("dotenv").config();

class ConfigurationService {
  constructor() {
    this.baseUrl = `${process.env.SERVE_AI_API_ENDPOINT}/configurations`;
    const clientId = process.env.SERVE_AI_CLIENT_ID;
    const clientSecret = process.env.SERVE_AI_CLIENT_SECRET;
    this.basicAuth =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }

  /**
   * Get phone call POC settings
   * @returns {Promise<object>} - Configuration object with greeting, prompt, humanAgentPhoneNumber
   */
  async getPhoneCallSettings() {
    try {
      const response = await axios.get(`${this.baseUrl}/phoneCallPOCSettings`, {
        headers: {
          Authorization: this.basicAuth,
        },
      });

      if (response.data && response.data.data) {
        const config = response.data.data.value;

        // Validate required fields
        if (
          !config.greeting ||
          !config.prompt ||
          !config.humanAgentPhoneNumber ||
          !config.chatflowId ||
          !config.elevenLabsAgentId
        ) {
          console.warn(
            "⚠️ Configuration missing required fields, using defaults"
          );
          return this.getDefaultConfig();
        }

        // Inject today's date in Malaysia time into the prompt
        config.prompt = this.injectTodayDate(config.prompt);

        console.log("✅ Configuration loaded successfully");
        return config;
      } else {
        console.error("❌ Invalid configuration response structure");
        return this.getDefaultConfig();
      }
    } catch (error) {
      console.error("❌ Error fetching configuration:", error.message);
      // Return default config on error
      return this.getDefaultConfig();
    }
  }

  /**
   * Get default configuration fallback
   */
  getDefaultConfig() {
    console.log("📋 Using default configuration");
    const defaultPrompt =
      process.env.SYSTEM_PROMPT ||
      `You are a friendly and helpful AI assistant for a phone call support system.`;

    return {
      greeting:
        process.env.WELCOME_GREETING ||
        "Hello, I'm an AI agent. How can I help you?",
      prompt: this.injectTodayDate(defaultPrompt),
      humanAgentPhoneNumber: process.env.HUMAN_AGENT_NUMBER || null,
      chatflowId: process.env.SERVE_AI_CHATFLOW_ID || null,
      provider: "openai",
    };
  }

  /**
   * Inject today's date and time in Malaysia time into the prompt
   * @param {string} prompt - The prompt text
   * @returns {string} - Prompt with injected date and time
   */
  injectTodayDate(prompt) {
    try {
      // Get current date and time in Malaysia timezone (MYT - UTC+8)
      const malaysiaDateTime = new Date().toLocaleString("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });

      // Inject date and time information at the beginning of the prompt
      const dateInfo = `Current date and time: ${malaysiaDateTime} (MYT - Malaysia Time).`;

      return dateInfo + prompt;
    } catch (e) {
      console.error("Error injecting date into prompt:", e);
      return prompt;
    }
  }
}

module.exports = new ConfigurationService();
