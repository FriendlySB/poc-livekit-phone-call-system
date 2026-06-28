/**
 * Self-hosted VoxCPM 1.5 TTS adapter for the LiveKit voice pipeline.
 *
 * WHY A CUSTOM CLIENT (like Chatterbox, not a stock openai.TTS):
 * VoxCPM is served by nano-vLLM-VoxCPM, whose `/generate` endpoint is NOT
 * OpenAI-shaped — it takes `{ target_text, prompt_latents_base64, prompt_text,
 * cfg_value, ... }` and, by default, streams MP3. We added a `format:"pcm"` mode to
 * that server (deployment fork) so it streams headerless 16-bit LE mono PCM at the
 * model's 44.1 kHz instead. That lets us feed the body straight into AudioByteStream
 * with NO container parsing at all — even simpler than chatterboxTts.mjs (which has to
 * strip a RIFF header from wav output).
 *
 * VOICE: a FIXED reference-clone voice. We encode a reference WAV once (offline, via
 * the server's /encode_latents) into latents + its transcript, store them in a JSON
 * file (VOXCPM_VOICE_FILE), and reuse them on every call for a consistent voice. If no
 * voice file is configured, we fall back to VoxCPM's zero-shot (default) voice.
 *
 * Capabilities are `{ streaming: false }` — i.e. no incremental TEXT input; the
 * AgentSession auto-wraps it for per-sentence synthesis (exactly like Chatterbox/
 * Speaches), so multi-sentence replies synthesize sentence-by-sentence with no extra
 * wiring here. We DO, however, stream the RESPONSE body incrementally (see run()):
 * frames are emitted as PCM bytes arrive, not after buffering the whole clip — this is
 * what keeps LiveKit's stall watchdog fed on slow first generations. Framing
 * (requestId/segmentId/final) mirrors the openai plugin.
 */

import { readFileSync } from "node:fs";
import { AudioByteStream, shortuuid, tts } from "@livekit/agents";

// VoxCPM 1.5 outputs 44.1 kHz mono. The PCM `format` mode emits raw 16-bit LE samples
// at this rate, which is exactly how AudioByteStream interprets the bytes we hand it.
// (The Twilio bridge resamples to 8 kHz µ-law downstream, so 44.1 kHz here is fine.)
const VOXCPM_SAMPLE_RATE = 44100;
const VOXCPM_CHANNELS = 1;

/**
 * Load the fixed reference-clone voice from a JSON file.
 *
 * The file holds the /encode_latents output plus the reference transcript:
 *   { "prompt_latents_base64": "...", "prompt_text": "..." }
 * Returns null when unset, missing, or malformed — the caller then synthesizes
 * zero-shot (VoxCPM's default voice) instead of failing the whole TTS leg.
 *
 * @param {string | undefined} path - VOXCPM_VOICE_FILE (relative to cwd or absolute).
 * @returns {{ prompt_latents_base64: string, prompt_text: string } | null}
 */
function loadVoice(path) {
  if (!path) return null;
  try {
    // Strip a leading UTF-8 BOM (﻿) — JSON files authored on Windows often carry
    // one, and JSON.parse chokes on it.
    const v = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    if (v?.prompt_latents_base64 && v?.prompt_text) {
      return { prompt_latents_base64: v.prompt_latents_base64, prompt_text: v.prompt_text };
    }
    console.warn(`[voxcpm] voice file ${path} missing prompt_latents_base64/prompt_text — using zero-shot`);
  } catch (err) {
    console.warn(`[voxcpm] could not read voice file ${path} (${err.message}) — using zero-shot`);
  }
  return null;
}

/**
 * Build the /generate request body shared by synthesis and warm-up.
 *
 * NOTE on max_generate_length: this is a hard SAFETY CAP on generation steps, not a
 * normal limit. VoxCPM occasionally fails to emit an end-of-speech token and "runs away",
 * generating until the cap (~0.16s of audio per step). At the server default (2000) that's
 * ~5 minutes of garbage taking ~45s wall — long past LiveKit's ~10s stall watchdog, which
 * hangs the whole turn. We cap at 200 (~32s audio max, a few seconds wall) so a runaway is
 * bounded well under the watchdog; normal sentences emit EOS in 20-60 steps, far below the
 * cap, so it never truncates real speech. Also stays within `prompt(~113) + cap <= 2048`.
 * Env-overridable via VOXCPM_MAX_GENERATE_LENGTH.
 *
 * @param {string} text
 * @param {ReturnType<typeof readVoxcpmOpts>} opts
 */
export function buildGenerateBody(text, opts) {
  const body = {
    target_text: text,
    cfg_value: opts.cfgValue,
    max_generate_length: opts.maxGenerateLength,
    temperature: opts.temperature,
    format: "pcm", // our server fork's raw-PCM mode (skips MP3 encode)
  };
  if (opts.voice) {
    // Latents prompt requires a non-empty prompt_text (server-enforced). Omit BOTH for
    // zero-shot — the server rejects prompt_text when no latents are supplied.
    body.prompt_latents_base64 = opts.voice.prompt_latents_base64;
    body.prompt_text = opts.voice.prompt_text;
  }
  return body;
}

/** Read VoxCPM config + voice once from env. @param {NodeJS.ProcessEnv} env */
export function readVoxcpmOpts(env) {
  return {
    baseURL: (env.VOXCPM_BASE_URL || "").replace(/\/$/, ""),
    cfgValue: Number(env.VOXCPM_CFG_VALUE ?? 2),
    maxGenerateLength: Number(env.VOXCPM_MAX_GENERATE_LENGTH ?? 200),
    temperature: Number(env.VOXCPM_TEMPERATURE ?? 1),
    voice: loadVoice(env.VOXCPM_VOICE_FILE),
  };
}

/**
 * Batch TTS backed by the self-hosted nano-vLLM-VoxCPM server's /generate endpoint.
 */
export class VoxcpmTTS extends tts.TTS {
  #opts;
  label = "voxcpm.TTS";

  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    super(VOXCPM_SAMPLE_RATE, VOXCPM_CHANNELS, { streaming: false });
    this.#opts = readVoxcpmOpts(env);
  }

  get model() {
    return "voxcpm-1.5";
  }

  get provider() {
    try {
      return new URL(this.#opts.baseURL).host;
    } catch {
      return "voxcpm";
    }
  }

  /**
   * @param {string} text
   * @param {import("@livekit/agents").APIConnectOptions} [connOptions]
   * @param {AbortSignal} [abortSignal]
   */
  synthesize(text, connOptions, abortSignal) {
    return new VoxcpmChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream() {
    // VoxCPM's /generate is request/response only — no token streaming.
    throw new Error("Streaming is not supported on VoxCPM TTS");
  }
}

/**
 * One synthesis request: POST text -> raw PCM, emit PCM frames.
 * Mirrors the openai plugin's ChunkedStream framing (one requestId, last frame final).
 */
class VoxcpmChunkedStream extends tts.ChunkedStream {
  label = "voxcpm.ChunkedStream";
  #opts;

  constructor(ttsInstance, text, opts, connOptions, abortSignal) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#opts = opts;
  }

  async run() {
    try {
      const res = await fetch(`${this.#opts.baseURL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // VoxCPM has no auth
        body: JSON.stringify(buildGenerateBody(this.inputText, this.#opts)),
        signal: this.abortSignal,
      });
      if (!res.ok) {
        throw new Error(`VoxCPM TTS failed: ${res.status} ${await res.text()}`);
      }

      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(VOXCPM_SAMPLE_RATE, VOXCPM_CHANNELS);

      // Defer emitting each frame so the LAST one (after flush) can be marked final:true.
      let lastFrame;
      const pushFrames = (frames) => {
        for (const frame of frames) {
          if (lastFrame) this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final: false });
          lastFrame = frame;
        }
      };

      // STREAM the response body instead of buffering it. The server emits headerless
      // 16-bit LE mono PCM at 44.1 kHz AS it generates, so we feed frames to the pipeline
      // as bytes arrive (no RIFF/parsing needed). Buffering the whole clip
      // (await res.arrayBuffer()) gave LiveKit's ~10s stall watchdog a long silent gap on
      // slow first generations and forced the stream closed; streaming keeps frames flowing
      // and surfaces the server's ~230ms TTFB. `res.body` is a web ReadableStream that Node
      // exposes as async-iterable, yielding Uint8Array chunks (an ArrayBufferView that
      // AudioByteStream.write accepts directly).
      for await (const chunk of res.body) {
        pushFrames(audioByteStream.write(chunk));
      }
      // write() only yields whole 100 ms frames; flush() emits the trailing <100 ms
      // remainder so the tail of the segment isn't dropped.
      pushFrames(audioByteStream.flush());
      if (lastFrame) this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final: true });
    } catch (error) {
      // An interrupted turn aborts the fetch — that's expected, not an error.
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    } finally {
      this.queue.close();
    }
  }
}

/**
 * Pre-warm the VoxCPM server before the agent speaks its greeting.
 *
 * The model is resident at server boot, but the FIRST synthesis still pays a CUDA-kernel
 * warmup. The greeting is that first synth, and the pipeline force-closes a turn if the
 * first TTS frame is late (~10s) — so a throwaway request here absorbs the warmup, and
 * the greeting that follows is fast. On an already-warm server it returns quickly, so the
 * per-call cost is negligible. We warm with the configured voice (the real call path) and
 * a short generation length to keep it cheap.
 *
 * Best-effort: any failure (server down, etc.) is swallowed — the real call still
 * proceeds and just pays the warmup on the greeting instead.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export async function warmVoxcpmTts(env) {
  const opts = readVoxcpmOpts(env);
  if (!opts.baseURL) return;
  try {
    const body = buildGenerateBody("warm up", { ...opts, maxGenerateLength: 64 });
    const res = await fetch(`${opts.baseURL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // CRITICAL: drain the response body to completion. nano-vLLM serves ONE request at a
    // time and relies on HTTP backpressure, so an UNREAD streaming response keeps the
    // inference slot busy — which, on a cold server, blocks the very next request (the
    // greeting) indefinitely. Reading it fully lets the warmup finish and free the slot,
    // and is what actually absorbs the first-call CUDA warmup cost.
    await res.arrayBuffer();
  } catch {
    // ignore — warmup on first real synth is the fallback
  }
}
