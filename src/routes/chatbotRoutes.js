const express = require('express');
const router = express.Router();
const chatbotService = require('../services/chatbotService');

/**
 * Test chatbot endpoint
 */
router.post('/test', async (req, res) => {
  const { message, callSid } = req.body;
  
  if (!message) {
    return res.status(400).json({
      success: false,
      error: 'Message is required'
    });
  }

  const testCallSid = callSid || `TEST_${Date.now()}`;
  
  try {
    const response = await chatbotService.sendMessage(testCallSid, message);
    
    res.json({
      success: true,
      callSid: testCallSid,
      userMessage: message,
      botResponse: response
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get active chat sessions
 */
router.get('/sessions', (req, res) => {
  const sessions = chatbotService.getActiveSessions();
  
  res.json({
    success: true,
    sessions,
    count: sessions.length
  });
});

/**
 * Clear chat session
 */
router.delete('/sessions/:callSid', (req, res) => {
  const { callSid } = req.params;
  
  chatbotService.clearSession(callSid);
  
  res.json({
    success: true,
    message: `Chat session cleared for ${callSid}`
  });
});

module.exports = router;
