const express = require('express');
const router = express.Router();
const openAIController = require('../controllers/openAIController');

// OpenAI Realtime webhook (for conference-based calling)
router.post(
  '/realtime-webhook',
  express.raw({ type: 'application/json' }),
  openAIController.handleRealtimeWebhook
);

// Get all active OpenAI sessions
router.get('/sessions', openAIController.getActiveSessions);

// Health check
router.get('/health', openAIController.healthCheck);

module.exports = router;
