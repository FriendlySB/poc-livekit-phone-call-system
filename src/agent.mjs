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
 *   STT: ElevenLabs scribe_v2_realtime | Speaches whisper (batch) | sherpa-onnx
 *        (self-hosted streaming) | SenseVoice (self-hosted offline batch)
 *   LLM: OpenAI gpt-4.1 via the Responses API                — our own key
 *   TTS: ElevenLabs multilingual | self-hosted Speaches Kokoro | self-hosted Chatterbox | self-hosted VoxCPM 1.5
 *   VAD: bundled local Silero (inference.VAD), shared by the session + STT adapter
 *
 * Provider selection is PER CALL: ServeAI's phoneCallConfig.liveKitSTT/liveKitTTS arrive in the
 * dispatch metadata and pick each leg (same keys as the createStt/createTts branches). The
 * process.env.STT_PROVIDER/TTS_PROVIDER vars are now an optional local override/fallback only.
 * The factories themselves live in agentProviders.mjs; both default to ElevenLabs.
 *
 * The system prompt and the spoken greeting come from ServeAI config, passed
 * per-call as dispatch metadata (ctx.job.metadata), along with chatflowId,
 * callSid and callerNumber for chat-history persistence.
 *
 * Scope: conversation + transcription persistence (Step 3a) + ServeAI tool calling
 * (Step 3b). Every finalized caller turn and agent reply is written to ServeAI chat
 * history via a sequential queue (ordered, one insert at a time) and flushed on
 * shutdown. The LLM is also given 6 granular ServeAI tools (knowledge + appointment
 * actions, see agentTools.mjs) so it can act on the call, matching the ElevenLabs
 * agent. Both persistence and tools are gated on chatflowId — if it's absent the
 * worker logs only and exposes no tools, exactly like Step 2. (addHumanAgent transfer
 * is deferred to a later phase.)
 * Run:   `npm run agent`  (runs `node src/agent.mjs dev`)
 *
 * ESM (.mjs): @livekit/agents is ESM-only, so this worker is a standalone ESM
 * module while the rest of the CommonJS backend is unchanged. chatbotService is a
 * CommonJS singleton; default-importing it here is standard Node ESM<->CJS interop.
 */

import { defineAgent, voice, cli, WorkerOptions, inference } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import chatbotService from "./services/chatbotService.js";
import { createPersistQueue } from "./persistQueue.mjs";
// STT/TTS are chosen per-env (ElevenLabs default | self-hosted Speaches) — see agentProviders.mjs.
import {
  createStt,
  createTts,
  warmSpeachesTts,
  warmChatterboxTts,
  warmVoxcpmTts,
  warmPocketTts,
  warmVibevoiceTts,
} from "./agentProviders.mjs";
// ServeAI knowledge/appointment tools exposed to the LLM — see agentTools.mjs.
import { createServeAiTools } from "./agentTools.mjs";
// Offline SenseVoice model preloader (in-process; loaded in prewarm) — see senseVoiceStt.mjs.
import { getOfflineRecognizer } from "./senseVoiceStt.mjs";

export default defineAgent({
  // prewarm runs in the (optionally pre-forked) job process BEFORE entry, so anything
  // expensive and CALL-INDEPENDENT is loaded here rather than on the first turn.
  //
  // The LLM is deliberately NOT prewarmed here. Its Responses WebSocket was opened at
  // fork time and then sat idle until a call arrived — but the plugin's connection pool
  // only expires sockets by AGE (WS_MAX_SESSION_DURATION = 1 hour) and has no idle
  // detection. After ~7 minutes idle the socket is silently dropped upstream, the pool
  // still hands it out, and the request goes into a half-open connection. The failure
  // surfaces as a close event ~19s later ("OpenAI Responses WebSocket closed
  // unexpectedly"), so the first turn of any call following an idle gap stalled ~19s
  // before a single token. The LLM is now built per job in entry() instead; see there.
  prewarm: (proc) => {
    // The in-process STTs (sherpa ~190MB, SenseVoice ~930MB) load an ONNX model that's
    // expensive on the first turn. Provider selection is now per-call (ServeAI liveKitSTT),
    // which prewarm CAN'T see — it runs in the idle process before any call. So we only
    // warm-preload here when process.env.STT_PROVIDER is set as a local override/hint; in
    // that case the model is resident before the first turn (reused in entry). Without the
    // env hint, a config-selected sherpa/SenseVoice call cold-loads its model on the first
    // turn — set STT_PROVIDER in .env when specifically A/B-testing those two.
    if (process.env.STT_PROVIDER === "sherpa") {
      const sherpaStt = createStt(process.env);
      sherpaStt.prewarm();
      proc.userData.stt = sherpaStt;
    }
    if (process.env.STT_PROVIDER === "sensevoice") {
      getOfflineRecognizer(process.env);
    }
  },
  entry: async (ctx) => {
    // Join the LiveKit room this job was dispatched to.
    await ctx.connect();

    // Built PER JOB, not in prewarm — see the prewarm comment for why a process-level
    // socket goes stale. prewarm() here is non-blocking: the WebSocket handshake
    // (~300ms) runs in the background while we parse metadata, build the pipeline, warm
    // the TTS and speak the greeting (~5s), so it is fully hidden by the time the
    // caller's first turn lands — the same benefit as before, on a socket that is only
    // seconds old instead of minutes.
    const llm = new openai.responses.LLM({
      apiKey: process.env.OPENAI_API_KEY,
      // gpt-4.1-mini: lower time-to-first-token than gpt-4.1 — the single biggest
      // chunk of response latency on this stack (~0.95s -> ~0.4-0.5s).
      // Revert to "gpt-4.1" if reply quality regresses.
      model: process.env.AGENT_LLM_MODEL || "gpt-4.1-mini",
    });
    llm.prewarm();

    // Per-call config from ServeAI, forwarded by the backend as dispatch metadata.
    // Falls back to "{}" so the worker still runs if metadata is ever missing.
    // chatflowId/callSid/callerNumber drive ServeAI chat-history persistence below.
    // liveKitSTT/liveKitTTS pick the STT/TTS leg PER CALL (ServeAI phoneCallConfig).
    const { prompt, greeting, chatflowId, callSid, callerNumber, liveKitSTT, liveKitTTS } =
      JSON.parse(ctx.job.metadata || "{}");

    // Provider selection is per-call: ServeAI's liveKitSTT/liveKitTTS choose the leg, using
    // the same keys as the old STT_PROVIDER/TTS_PROVIDER env switches. process.env.* remains an
    // optional local override/fallback (e.g. testing without ServeAI). Connection configs (base
    // URLs, models, voices) always come from process.env, so we just override the provider switch
    // on a shallow copy and pass that to createStt/createTts.
    const sttEnv = liveKitSTT ? { ...process.env, STT_PROVIDER: liveKitSTT } : process.env;
    const ttsEnv = liveKitTTS ? { ...process.env, TTS_PROVIDER: liveKitTTS } : process.env;

    // ServeAI chat-history persistence (gated on chatflowId
    // Serial, ordered, drop-safe queue (see persistQueue.mjs for the guarantees).
    // null when chatflowId is absent -> the handlers below log only, like Step 2.
    const queue = chatflowId
      ? createPersistQueue(chatbotService, { chatflowId, callSid, callerNumber })
      : null;

    // ServeAI tools for the LLM (knowledge + appointment actions). Gated on chatflowId
    // for the same reason as the queue: without it there's no ServeAI session to query.
    // undefined -> the Agent below gets no tools, so it's conversation-only like Step 2.
    const tools = chatflowId
      ? createServeAiTools(chatbotService, { chatflowId, callSid, callerNumber })
      : undefined;
    // Drain the queue before the per-job process exits (caller hung up), so the
    // last enqueued/in-flight turns reach ServeAI instead of being lost. Registered
    // now (before session.start) so a flush still happens if startup later fails.
    if (queue) {
      ctx.addShutdownCallback(async () => {
        await queue.flush();
        chatbotService.clearSession(callSid);
      });
    }

    // Speaches/Whisper and SenseVoice are BATCH: they commit no interim transcripts, so the
    // semantic end-of-utterance model has nothing incremental to score. In that mode we fall
    // back to pure VAD turn detection + a widened turn-grouping window below. The STREAMING
    // paths (ElevenLabs and sherpa-onnx) emit interim transcripts, so they keep the better
    // semantic EOU detector and snappier timings.
    const useBatchStt = ["speaches", "sensevoice"].includes(sttEnv.STT_PROVIDER);

    // Bundled, local Silero VAD (no cloud). Shared by the AgentSession (turn-taking
    // / interruption) and, when STT_PROVIDER=speaches, by the STT StreamAdapter that
    // endpoints batch whisper. AgentSession would auto-provision an identical one if
    // omitted; we create it explicitly so the same instance backs both consumers.
    // For batch STT, widen minSilenceDuration above the 250ms default so a brief
    // mid-thought pause is less likely to end the turn and fragment multi-part speech
    // ("...that's it." pause "Thank you.") into two turns. This is a compromise: 700ms
    // grouped multi-part speech well but added ~0.45s of felt turn-end delay; 450ms
    // trades a little grouping for snappier replies — the VAD window is the most-felt
    // turn-end latency we control (STT/LLM cost the rest). It's the only turn-grouping
    // knob here, since batch STT yields no interim transcripts for a semantic detector.
    const sttVad = new inference.VAD({
      model: "silero",
      ...(useBatchStt ? { minSilenceDuration: 450 } : {}),
    });

    const session = new voice.AgentSession({
      // STT per-call (sttEnv): ElevenLabs (default) | Speaches batch | sherpa streaming |
      // SenseVoice offline. sherpa's model is preloaded in prewarm ONLY when process.env picks
      // it (prewarm can't see per-call metadata) — reuse that warm instance when present, else
      // build fresh (cold first turn). SenseVoice reuses its module-memoized model the same way.
      // TTS is independent (createTts, ttsEnv).
      stt:
        sttEnv.STT_PROVIDER === "sherpa" && ctx.proc.userData.stt
          ? ctx.proc.userData.stt
          : createStt(sttEnv, sttVad),
      // LLM orchestrator — the per-job instance prewarmed at the top of entry()
      llm,
      tts: createTts(ttsEnv),
      // Explicit VAD shared with the STT adapter (see above).
      vad: sttVad,
      // Turn-taking: decide when the caller has finished so we don't reply mid-sentence.
      turnHandling: {
        turnDetection: useBatchStt
          ? // Batch STT -> rely on VAD silence to end the turn.
            "vad"
          : // Lower the end-of-turn confidence threshold (default ~0.56).
            new inference.TurnDetector({
              unlikelyThreshold: 0.2,
              // On a self-hosted server there's no LiveKit Cloud inference gateway, so
              // the default cloud model ("v1") can't connect — it burns ~4-6s retrying
              // on every call before falling back. Use the local in-process "v1-mini"
              // model directly. Cloud mode keeps the better cloud model via auto-select.
              ...(process.env.LIVEKIT_MODE === "selfhost" ? { version: "v1-mini" } : {}),
            }),
        // Endpointing waits, in ms, since the last detected speech. For batch STT,
        // keep minDelay aligned with the VAD window (above) so the turn doesn't commit
        // before the grouping pause elapses; ElevenLabs streaming STT stays snappy.
        endpointing: useBatchStt
          ? { minDelay: 450, maxDelay: 2000 }
          : { minDelay: 300, maxDelay: 1200 },
        interruption: {
          // minWords defaults to 0, so a SINGLE word interrupts. Whisper reliably
          // hallucinates "You" / "Thank you." on short noise segments, and one of those
          // landing mid-reply aborts the turn — which, if a tool call is in flight, also
          // cancels it before its output is submitted. The OpenAI Responses session is
          // stateful server-side, so the next turn then 400s with "No tool output found
          // for function call ...". Requiring two words filters the hallucinations out.
          // Cost: a genuine one-word barge-in ("stop") no longer interrupts.
          minWords: 2,
        },
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
        // ServeAI knowledge/appointment tools (undefined when no chatflowId -> no tools).
        // The framework runs the tool-call loop automatically when the LLM invokes one.
        tools,
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
    // Self-hosted TTS pays a cold-start on its first synthesis (Kokoro ~6s model load;
    // Chatterbox/VoxCPM/VibeVoice CUDA-kernel warmup; Pocket CPU model load). Warm it now so
    // the greeting below isn't cut off by the pipeline's first-frame timeout. No-op for ElevenLabs.
    if (ttsEnv.TTS_PROVIDER === "speaches") {
      await warmSpeachesTts(ttsEnv);
    } else if (ttsEnv.TTS_PROVIDER === "chatterbox") {
      await warmChatterboxTts(ttsEnv);
    } else if (ttsEnv.TTS_PROVIDER === "voxcpm") {
      await warmVoxcpmTts(ttsEnv);
    } else if (ttsEnv.TTS_PROVIDER === "pocket") {
      await warmPocketTts(ttsEnv);
    } else if (ttsEnv.TTS_PROVIDER === "vibevoice") {
      await warmVibevoiceTts(ttsEnv);
    }
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
