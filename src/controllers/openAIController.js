/**
 * OpenAI Controller
 * Handles API requests for OpenAI Realtime features
 */

const openAIRealtimeService = require('../services/openAIRealtimeService');

/**
 * Handle OpenAI Realtime webhook for incoming calls
 * This receives webhooks from OpenAI when a SIP call is initiated
 */
const handleRealtimeWebhook = async (req, res) => {
  await openAIRealtimeService.handleRealtimeWebhook(req, res);
};

/**
 * Get all active OpenAI sessions
 */
const getActiveSessions = (req, res) => {
  const sessions = openAIRealtimeService.getActiveSessions();
  
  res.json({
    sessions,
    count: sessions.length
  });
};

/**
 * Health check endpoint
 */
const healthCheck = (req, res) => {
  res.status(200).send('Health ok');
};

module.exports = {
  handleRealtimeWebhook,
  getActiveSessions,
  healthCheck
};
