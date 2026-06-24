# ElevenLabs Voice Agent Phone Call Demo

An inbound AI phone call system that supports two voice agent providers: **ElevenLabs** and **OpenAI Realtime API**. The active provider is selected via configuration fetched from ServeAI at the start of each call. Both providers integrate with ServeAI's knowledge base and appointment tools, support human agent escalation with live transcription, and record the full conversation into the ServeAI chat history after the call ends.

## Features

- Provider-switchable AI voice agent — ElevenLabs or OpenAI Realtime, selected per DB config
- Inbound call handling via Twilio webhook
- ServeAI tool integration: knowledge base queries and appointment management (7 tools)
- Human agent escalation — dials a live agent, redirects caller into a conference, transcribes both sides
- Post-call transcript insertion into ServeAI chat history
- Bidirectional audio transcription via OpenAI Realtime (used during human agent conferences)
- Multi-language support

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the required credentials:
```env
PORT=5000
HOST=your-public-domain.com

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_PROJECT_ID=your_openai_project_id
OPENAI_WEBHOOK_SECRET=your_openai_webhook_secret

# ElevenLabs
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_AGENT_ID=your_elevenlabs_agent_id

# Twilio
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token

# ServeAI
SERVE_AI_API_ENDPOINT=https://your-serveai-endpoint.com
SERVE_AI_CLIENT_ID=your_client_id
SERVE_AI_CLIENT_SECRET=your_client_secret
```

3. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

## Configuration

All call behaviour is driven by configuration fetched from ServeAI at the start of each call (`GET /configurations/phoneCallPOCSettings`). The config object must include:

| Field | Description |
|-------|-------------|
| `provider` | `"elevenlabs"` or `"openai"` — selects the voice agent |
| `prompt` | System prompt injected into the agent |
| `greeting` | Opening message spoken when the call connects |
| `chatflowId` | ServeAI chatflow used for tool queries and chat history |
| `humanAgentPhoneNumber` | Phone number to dial when escalating to a human agent |
| `humanAgentTimeout` | Seconds to wait for the human agent to answer (default: 40) |
| `elevenLabsAgentId` | ElevenLabs agent ID (required when `provider` is `"elevenlabs"`) |
| `language` | Language code for the agent (default: `"en"`) |

Today's date and time (Malaysia Time, UTC+8) is automatically injected into the prompt before every call.

## API Endpoints

### Twilio Webhooks (`/api/phone-call/twilio`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/incoming-call` | Twilio webhook — handles all inbound calls, routes to the configured provider |
| `POST` | `/call-status` | Twilio call status updates |
| `POST` | `/conference-events` | Conference participant events (OpenAI human agent transfer) |
| `POST` | `/transfer-conference-events` | Conference events for ElevenLabs human agent transfer conferences |
| `POST` | `/stream-status` | Media stream status callbacks (acknowledged, not processed) |

### ElevenLabs Webhooks (`/api/phone-call/elevenlabs`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook` | Post-call transcript webhook from ElevenLabs |
| `POST` | `/tool/:toolName` | Live tool call webhooks during an active conversation |
| `POST` | `/transfer-status` | Twilio status callback for the outbound human agent call leg |
| `GET`  | `/sessions` | Debug — list active ElevenLabs conversations |

### OpenAI Webhooks (`/api/phone-call/openai`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/realtime-webhook` | OpenAI Realtime incoming call event |
| `GET`  | `/sessions` | List active OpenAI Voice Agent sessions |
| `GET`  | `/health` | Service health check |

### General

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/health` | Server health check — includes active session counts for both providers |

### WebSocket

- `wss://your-domain.com/api/twilio/media-stream` — Receives Twilio Media Stream audio; used for bidirectional transcription during human agent conferences

## How It Works

### 1. Inbound Call Flow

1. A caller dials the Twilio number; Twilio POSTs to `/api/phone-call/twilio/incoming-call`.
2. The server fetches the call configuration from ServeAI to determine the provider.
3. The call is routed to the **ElevenLabs path** or the **OpenAI path** based on `config.provider`.

### 2. ElevenLabs Path

1. The server calls `POST https://api.elevenlabs.io/v1/convai/twilio/register-call` with the agent ID, prompt, greeting, and dynamic variables (caller number, chatflow ID).
2. ElevenLabs returns a TwiML string. The server extracts the `conversation_id` embedded in the TwiML and stores call metadata in memory.
3. The TwiML is returned verbatim to Twilio. Twilio opens a WebSocket directly to ElevenLabs — ServeAI is entirely out of the audio path for the duration of the AI agent conversation.
4. When the ElevenLabs agent invokes a tool, ElevenLabs POSTs to `/api/phone-call/elevenlabs/tool/:toolName`. The server executes the tool against ServeAI and responds with the result.
5. After the call ends, ElevenLabs POSTs the full conversation transcript to `/api/phone-call/elevenlabs/webhook`. The server inserts the transcript into ServeAI chat history.

### 3. OpenAI Path

1. The server places the caller into a named Twilio Conference and adds an OpenAI SIP participant to the same conference.
2. OpenAI fires a `realtime.call.incoming` webhook. The server accepts the call, injects the system prompt and greeting, and opens a WebSocket to the OpenAI Realtime API.
3. The AI Voice Agent handles the conversation. Tool calls are dispatched from the WebSocket message handler and executed against ServeAI.

### 4. Tool Integration

Both providers support the same set of tools, routed to ServeAI:

| Tool | Description |
|------|-------------|
| `knowledgeQuery` | Query the ServeAI knowledge base |
| `checkAvailability` | Check appointment slot availability |
| `createAppointment` | Book a new appointment |
| `fetchAppointment` | Retrieve an existing appointment |
| `updateAppointment` | Modify an existing appointment |
| `cancelAppointment` | Cancel an existing appointment |
| `addHumanAgent` | Escalate the call to a live human agent |

Tools for the ElevenLabs agent must be pre-configured on the ElevenLabs agent dashboard. Only `prompt`, `first_message`, `language`, and `voice_id` can be overridden per-call. The `addHumanAgent` tool should be set to **Post-Tool Speech** mode so the agent finishes speaking before the transfer is executed.

### 5. Human Agent Escalation (ElevenLabs)

1. ElevenLabs calls the `addHumanAgent` tool webhook; the server holds the response open.
2. The server dials the configured `humanAgentPhoneNumber` outbound via Twilio, placing the human agent into a waiting conference (`startConferenceOnEnter="false"`).
3. The server waits up to `humanAgentTimeout` seconds for the human agent to answer.
4. On answer: the server immediately responds to ElevenLabs (`{ result: "Call transferred successfully" }`), then redirects the caller's live call leg into the same conference. Both parties are now connected.
5. Media streams are started on both call legs for bidirectional transcription via OpenAI Realtime.
6. Transcribed messages are inserted into ServeAI chat history, buffered until the ElevenLabs post-call transcript has finished inserting to preserve correct ordering.
7. When the conference ends, all in-memory state is cleaned up.

### 6. Transcript Ordering

The ElevenLabs post-call webhook delivers the full AI agent transcript (Phase 1). If a human agent transfer occurred, the live transcription messages (Phase 2) are held in a buffer and only flushed to ServeAI after the Phase 1 transcript insert completes, ensuring messages appear in the correct chronological order in the chat history.

## Architecture

### Key Components

| Component | Role |
|-----------|------|
| `twilioController.js` | Inbound call routing; conference event handling; human agent stream setup |
| `elevenLabsService.js` | ElevenLabs register-call; tool webhook dispatch; human agent transfer; transcript insertion |
| `openAIRealtimeService.js` | OpenAI webhook handling; WebSocket lifecycle; tool call dispatch |
| `twilioStreamService.js` | WebSocket handler for Twilio Media Streams; routes audio to OpenAI Realtime transcription |
| `chatbotService.js` | ServeAI API client — session management, message sending, chat history insertion |
| `configurationService.js` | Fetches call settings (prompt, provider, chatflowId, human agent config) from ServeAI |

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP server port (default: 5000) |
| `HOST` | Yes | Public hostname used for Twilio callback URLs |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_PROJECT_ID` | Yes | OpenAI project ID (SIP destination for voice agent) |
| `OPENAI_WEBHOOK_SECRET` | Yes | Secret for verifying OpenAI webhook signatures |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs API key (`xi-api-key` header) |
| `ELEVENLABS_AGENT_ID` | Yes | Default ElevenLabs agent ID (can be overridden via DB config) |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `SERVE_AI_API_ENDPOINT` | Yes | Base URL of the ServeAI API |
| `SERVE_AI_CLIENT_ID` | Yes | ServeAI Basic Auth client ID |
| `SERVE_AI_CLIENT_SECRET` | Yes | ServeAI Basic Auth client secret |
