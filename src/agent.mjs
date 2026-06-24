/**
 * LiveKit Agent Worker — POC Step 2 (free-form voice conversation)
 *
 * A standalone agents-js worker process, separate from the Express backend.
 * It opens an OUTBOUND WebSocket to LiveKit Cloud (LIVEKIT_URL) and registers
 * under the agent name "serveai-poc". When the backend bridges an inbound Twilio
 * call into a room and dispatches this agent (see twilioController.js), LiveKit
 * assigns the job here; the worker joins the room and runs a full cascaded
 * STT -> LLM -> TTS voice pipeline so the caller can converse freely.
 *
 *   STT: ElevenLabs scribe_v2_realtime (multilingual auto-detect) — our own key
 *   LLM: OpenAI gpt-4.1 via the Responses API                — our own key
 *   TTS: ElevenLabs eleven_flash_v2_5                            — our own key
 *   VAD: bundled Silero, auto-provisioned by AgentSession        — nothing to add
 *
 * The system prompt and the spoken greeting come from ServeAI config, passed
 * per-call as dispatch metadata (ctx.job.metadata), along with chatflowId,
 * callSid and callerNumber for chat-history persistence.
 *
 * Scope: conversation + transcription persistence (Step 3a). Every finalized
 * caller turn and agent reply is written to ServeAI chat history via a sequential
 * queue (ordered, one insert at a time) and flushed on shutdown. Persistence is
 * gated on chatflowId — if it's absent the worker logs only, exactly like Step 2.
 * No tool calls yet.
 * Run:   `npm run agent`  (runs `node src/agent.mjs dev`)
 *
 * ESM (.mjs): @livekit/agents is ESM-only, so this worker is a standalone ESM
 * module while the rest of the CommonJS backend is unchanged. chatbotService is a
 * CommonJS singleton; default-importing it here is standard Node ESM<->CJS interop.
 */

import { defineAgent, voice, cli, WorkerOptions, inference } from "@livekit/agents";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import chatbotService from "./services/chatbotService.js";
import { createPersistQueue } from "./persistQueue.mjs";

export default defineAgent({
  // prewarm runs in the (optionally pre-forked) job process BEFORE entry, so the
  // LLM's Responses WebSocket is already open when the caller's first turn lands —
  // the first reply doesn't pay the connection handshake. Stored on proc.userData
  // and reused in entry. (Only the LLM exposes prewarm(); STT/TTS do not.)
  prewarm: (proc) => {
    const llm = new openai.responses.LLM({
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4.1",
    });
    llm.prewarm();
    proc.userData.llm = llm;
  },
  entry: async (ctx) => {
    // Join the LiveKit room this job was dispatched to.
    await ctx.connect();

    // Per-call config from ServeAI, forwarded by the backend as dispatch metadata.
    // Falls back to "{}" so the worker still runs if metadata is ever missing.
    // chatflowId/callSid/callerNumber drive ServeAI chat-history persistence below.
    const { prompt, greeting, chatflowId, callSid, callerNumber } = JSON.parse(
      ctx.job.metadata || "{}"
    );

    // ServeAI chat-history persistence (gated on chatflowId
    // Serial, ordered, drop-safe queue (see persistQueue.mjs for the guarantees).
    // null when chatflowId is absent -> the handlers below log only, like Step 2.
    const queue = chatflowId
      ? createPersistQueue(chatbotService, { chatflowId, callSid, callerNumber })
      : null;
    // Drain the queue before the per-job process exits (caller hung up), so the
    // last enqueued/in-flight turns reach ServeAI instead of being lost. Registered
    // now (before session.start) so a flush still happens if startup later fails.
    if (queue) {
      ctx.addShutdownCallback(async () => {
        await queue.flush();
        chatbotService.clearSession(callSid);
      });
    }

    const session = new voice.AgentSession({
      // STT — ElevenLabs Scribe v2 realtime, our own key (reuses ELEVENLABS_API_KEY,
      // same account as the TTS). scribe_v2_realtime is the streaming model and
      // transcribes noticeably better than gpt-4o-transcribe. languageCode is
      // omitted so it auto-detects per utterance (multilingual). Note: keyterm
      // biasing is NOT supported on the realtime model, only on batch Scribe.
      stt: new elevenlabs.STT({
        apiKey: process.env.ELEVENLABS_API_KEY,
        modelId: "scribe_v2_realtime",
        // The realtime model commits a final transcript only after its server-side
        // VAD sees a silence gap — default 1.5s, which was the bulk of the response
        // lag. Shorten it to 0.6s (range 0.3–3s) so the final lands ~0.9s sooner.
        // The local turn detector above still decides if the turn is truly over, so
        // an early commit on a mid-sentence pause just gets re-evaluated, not acted on.
        serverVad: { vadSilenceThresholdSecs: 0.6 },
      }),
      // LLM orchestrator — reuse the connection prewarmed above
      llm: ctx.proc.userData.llm,
      // TTS — connect directly to ElevenLabs with our own key.
      tts: new elevenlabs.TTS({
        apiKey: process.env.ELEVENLABS_API_KEY,
        voiceId: process.env.ELEVENLABS_VOICE_ID,
        model: "eleven_multilingual_v2",
      }),
      // Turn-taking: decide when the caller has finished so we don't reply mid-sentence.
      turnHandling: {
        // Lower the end-of-turn confidence threshold (default ~0.56).
        turnDetection: new inference.TurnDetector({ unlikelyThreshold: 0.2 }),
        // Endpointing waits, in ms, since the last detected speech. 
        endpointing: { minDelay: 300, maxDelay: 1200 },
      },
    });

    // Log every turn, and (when chatflowId is set) persist it to ServeAI chat
    // history through the serial queue above. Registered before start() so we
    // don't miss the first turns. Enqueue is synchronous — the listeners stay
    // non-async so nothing awaits inside the audio pipeline.
    session.on("user_input_transcribed", (ev) => {
      // Fires repeatedly with partials; act only on the finalized utterance.
      if (!ev.isFinal) return;
      console.log(`[caller${ev.language ? " " + ev.language : ""}] ${ev.transcript}`);
      const text = (ev.transcript ?? "").trim();
      if (queue && text) {
        queue.persist(() => chatbotService.insertUserMessage(callSid, chatflowId, text));
      }
    });
    session.on("conversation_item_added", (ev) => {
      // item is a ChatMessage (or handoff); persist the agent's spoken replies.
      if (ev.item.role !== "assistant") return;
      const text = (ev.item.textContent ?? "").trim();
      console.log(`[agent] ${text}`);
      if (queue && text) {
        queue.persist(() => chatbotService.insertBotMessage(callSid, chatflowId, text));
      }
    });

    // Start the session with the configured instructions, then speak the
    // configured greeting. After this, AgentSession runs the STT->LLM->TTS loop
    // automatically for every caller turn — no further wiring needed.
    await session.start({
      agent: new voice.Agent({
        instructions:
          prompt || "You are a friendly phone assistant. Keep replies short and natural.",
        // Use the LLM's own text as the transcript, NOT ElevenLabs' TTS alignment.
        // With this on (the default), the session replaces the transcript with the
        // TTS's normalizedAlignment chars, which ElevenLabs romanizes for non-Latin
        // scripts — so Mandarin replies were persisted as pinyin ("Qing Shao...")
        // instead of 汉字. The alignment feature only matters for word-synced
        // captions in a frontend UI, which a phone call has none of.
        useTtsAlignedTranscript: false,
      }),
      room: ctx.room,
    });
    await session.say(greeting || "Hello, how can I help you?", {
      allowInterruptions: false,
    });
  },
});

// Register the worker with LiveKit under an explicit agent name.
cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "serveai-poc",
    // Keep one warmed-up job process standing by
    numIdleProcesses: 1,
  })
);
