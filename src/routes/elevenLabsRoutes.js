/**
 * ElevenLabs Routes
 */

const express = require("express");
const router = express.Router();
const elevenLabsController = require("../controllers/elevenLabsController");

// Post-call event webhooks
router.post("/webhook", elevenLabsController.handlePostCallWebhook);

// Twilio status callback for outbound human-agent calls (no auth needed — internal Twilio callback)
router.post("/transfer-status", elevenLabsController.handleTransferStatus);

// Live tool call webhooks
router.post("/tool/:toolName", elevenLabsController.handleToolWebhook);

// List active conversations
router.get("/sessions", elevenLabsController.getActiveSessions);

module.exports = router;
