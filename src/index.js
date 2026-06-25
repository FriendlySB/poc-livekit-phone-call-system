const express = require("express");
const http = require("http");
const WebSocket = require('ws');
require("dotenv").config();

const twilioRoutes = require("./routes/twilioRoutes");
const openAIRoutes = require("./routes/openAIRoutes");
const chatbotRoutes = require("./routes/chatbotRoutes");
const elevenLabsRoutes = require("./routes/elevenLabsRoutes");
const openAIRealtimeService = require("./services/openAIRealtimeService");
const elevenLabsService = require("./services/elevenLabsService");
const twilioStreamService = require("./services/twilioStreamService");
const livekitBridgeService = require("./services/livekitBridgeService");


const app = express();
const port = process.env.PORT || 5000;
const server = http.createServer(app);

// Two Twilio Media Streams WebSocket endpoints share one HTTP server, so we use the
// `noServer` pattern and route the upgrade by path (stacking two { server, path }
// servers does not work reliably):
//   /api/twilio/media-stream   -> human-agent / transcription streams (existing)
//   /api/twilio/livekit-bridge -> self-hosted Twilio<->LiveKit audio bridge
const mediaStreamWss = new WebSocket.Server({ noServer: true });
const bridgeWss = new WebSocket.Server({ noServer: true });

mediaStreamWss.on('connection', (ws, req) => twilioStreamService.handleConnection(ws, req));
bridgeWss.on('connection', (ws) => livekitBridgeService.handleConnection(ws));

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/api/twilio/media-stream') {
    mediaStreamWss.handleUpgrade(req, socket, head, (ws) => mediaStreamWss.emit('connection', ws, req));
  } else if (pathname === '/api/twilio/livekit-bridge') {
    bridgeWss.handleUpgrade(req, socket, head, (ws) => bridgeWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Middleware — these routes need the raw body (must be registered before express.json())
app.use('/api/phone-call/openai/realtime-webhook', express.raw({ type: 'application/json' }));
app.use('/api/phone-call/elevenlabs/webhook', express.raw({ type: '*/*' }));

// Other routes use JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/phone-call/twilio", twilioRoutes);
app.use("/api/phone-call/openai", openAIRoutes);
app.use("/api/phone-call/chatbot", chatbotRoutes);
app.use("/api/phone-call/elevenlabs", elevenLabsRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    openai: { activeSessions: openAIRealtimeService.getActiveSessions().length },
    elevenlabs: { activeSessions: elevenLabsService.getActiveSessions().length },
  });
});

// Start server
server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);

  if (!process.env.OPENAI_API_KEY) {
    console.warn("WARNING: OPENAI_API_KEY not found in environment variables");
  }
  
  if (!process.env.OPENAI_PROJECT_ID) {
    console.warn("WARNING: OPENAI_PROJECT_ID not found in environment variables");
  }
  
  if (!process.env.HUMAN_AGENT_NUMBER) {
    console.warn("WARNING: HUMAN_AGENT_NUMBER not found in environment variables");
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("WARNING: ELEVENLABS_API_KEY not found in environment variables");
  }

  if (!process.env.ELEVENLABS_AGENT_ID) {
    console.warn("WARNING: ELEVENLABS_AGENT_ID not found in environment variables");
  }
});
