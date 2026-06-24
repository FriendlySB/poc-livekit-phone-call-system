const express = require('express');
const router = express.Router();
const twilioController = require('../controllers/twilioController');

// Webhook endpoint for incoming calls
router.post('/incoming-call', twilioController.handleIncomingCall);

// Webhook endpoint for call status updates
router.post('/call-status', twilioController.handleCallStatus);

// Webhook endpoint for conference events (participant join/leave, conference end)
router.post('/conference-events', twilioController.handleConferenceEvents);

// Webhook endpoint for Phase 2 transfer conference events (ElevenLabs human agent transfer)
router.post('/transfer-conference-events', twilioController.handleTransferConferenceEvents);

// Webhook endpoint for stream status
router.post('/stream-status', (req, res) => {
  res.sendStatus(200);
});

module.exports = router;
