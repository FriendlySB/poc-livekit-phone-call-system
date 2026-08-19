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

// Place an outbound call (LiveKit path) — { to, instruction?, greeting? }
router.post('/outbound-call', twilioController.handleOutboundCall);

// Twilio fetches this when the callee ANSWERS an outbound call; returns the bridge TwiML
router.post('/outbound-answer', twilioController.handleOutboundAnswer);

// Called by the LiveKit agent's transferToHumanAgent tool — { callSid, chatflowId?, callerNumber }
router.post('/transfer-to-human', twilioController.handleTransferToHuman);

// Status callback for the human agent's leg during a LiveKit transfer
router.post('/human-transfer-status', twilioController.handleHumanTransferStatus);

module.exports = router;
