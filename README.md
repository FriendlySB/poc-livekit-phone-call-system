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

## Self-Hosted STT/TTS (Speaches)

The LiveKit agent worker (`src/agent.mjs`) runs a cascaded **STT → LLM → TTS** pipeline. Its STT and
TTS legs can each be switched, independently, between **ElevenLabs** (cloud, the default) and a
**self-hosted [Speaches](https://speaches.ai) box** via the `STT_PROVIDER` / `TTS_PROVIDER` env vars.
Speaches is a single OpenAI-compatible Docker container that serves **both** whisper STT
(`/v1/audio/transcriptions`) and Kokoro TTS (`/v1/audio/speech`), so one container covers both legs.

Provider selection lives in `src/agentProviders.mjs`. Leaving the switches unset keeps the original
ElevenLabs behaviour, so you can A/B each leg on a real call.

### Prerequisites

- **Docker Desktop** with the WSL2 backend.
- An **NVIDIA GPU** + recent driver for the `:latest-cuda` image. CPU-only works with the plain
  `:latest` image (drop `--gpus all`) but is much slower.

### 1. Start the container

```bash
docker run --rm -d --gpus all -p 8000:8000 --name speaches \
  -e WHISPER__INFERENCE_DEVICE=cuda -e WHISPER__COMPUTE_TYPE=float16 \
  -e WHISPER__TTL=-1 \
  -v hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cuda
```

- The API listens on **container port 8000** (mapped to host 8000). The Gradio **Playground UI** is at
  <http://localhost:8000>.
- `-v hf-hub-cache:...` persists downloaded models across restarts (a named Docker volume).
- `WHISPER__TTL=-1` stops the STT model from offloading. **TTL field names vary by image** — check the
  config dump that `docker logs speaches` prints at startup; the `:latest-cuda` build reads
  `WHISPER__TTL`, not `STT_MODEL_TTL`. Models still **cold-load on first use** (Kokoro ~6s; whisper's
  first CUDA inference compiles kernels, 10-30s), so warm them once before calling — see step 3.
- `WHISPER__COMPUTE_TYPE=float16` is important on **RTX 50-series (Blackwell)**: `int8` compute crashes
  cuBLAS there; `float16`/`bfloat16` work.
- `-d` runs detached and prints the container ID. Watch it with `docker logs -f speaches`; stop it with
  `docker stop speaches`.

### 2. Download the models

Models are pulled **server-side** into the cache volume. Either use the Playground UI (Models tab at
<http://localhost:8000>), or the Speaches CLI via `uvx` (runs the CLI without installing it — get `uv`
from <https://astral.sh/uv> if you don't have it):

```bash
# Tell the CLI where the server is — note: the server ROOT, no /v1 suffix
export SPEACHES_BASE_URL=http://localhost:8000

uvx speaches-cli model download Systran/faster-whisper-base          # STT (whisper)
uvx speaches-cli model download speaches-ai/Kokoro-82M-v1.0-ONNX      # TTS (Kokoro)
```

> The CLI's `SPEACHES_BASE_URL` is the server root (`http://localhost:8000`). The **app's**
> `SPEACHES_BASE_URL` in `.env` is the OpenAI API base and **must end in `/v1`** — they are not the same value.

### 3. Warm up & verify

Cold loads are slow, and the agent cuts off a turn if the first TTS frame doesn't arrive within ~10s —
so a cold model makes the **greeting silent and the first transcript fail**. Hit both endpoints once
before any real call to load + warm them (run the STT one **twice** — the second should be sub-second):

```bash
# TTS — Kokoro; also save a wav to feed the STT warmup
curl http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"warm up","model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"af_heart","response_format":"wav"}' \
  --output warm.wav

# STT — whisper (first run may take 10-30s: kernel compile; run again to confirm it's now fast)
curl -X POST http://localhost:8000/v1/audio/transcriptions \
  -F "file=@warm.wav" -F "model=Systran/faster-whisper-base"
```

Or use the Playground UI at <http://localhost:8000> (STT/TTS tabs).

### 4. Point the agent at Speaches

Set the switches and Speaches config in `.env` (see the env reference below), then run the LiveKit
agent worker:

```bash
npm run agent
```

Each leg is independent — e.g. `TTS_PROVIDER=speaches` with `STT_PROVIDER=elevenlabs` to get the cost
win on TTS while keeping ElevenLabs transcription quality.

### Notes & caveats

- **Batch STT.** The OpenAI-compatible whisper endpoint is non-streaming, so the agent runs it in batch
  mode wrapped in a local **Silero VAD** (bundled in `@livekit/agents`, no cloud). Because batch STT
  emits no interim transcripts, turn-taking automatically falls back to VAD endpointing when
  `STT_PROVIDER=speaches`.
- **STT model.** `faster-whisper-base` is fast but too inaccurate on 8 kHz phone audio — use
  `deepdml/faster-whisper-large-v3-turbo-ct2` (≈large-v3 accuracy, ~0.7 s on the GPU). Kokoro/TTS has
  **no Malay** and weak Mandarin — use a different TTS for SEA languages.
- **Latency.** A laptop self-host won't beat ElevenLabs' cloud. Measure on a **real streamed call**, not
  the Playground (which does batch round-trips and isn't representative).
- **Cold start.** The first call after startup (or after a model offloads) pays the load time and can
  arrive too late for the agent's first-frame timeout — silent greeting / aborted first transcript. Keep
  models warm (`WHISPER__TTL=-1` + the warm-up in step 3) and don't let the box sit idle before a demo.
- **Large models on Blackwell (RTX 50-series).** `large-v3-turbo` runs fine on the GPU at `float16`
  (verified on an RTX 5060, ~0.7 s/utterance) — Blackwell is **not** the blocker. If a transcription
  hangs/never returns, the real causes are: (1) a **truncated download** — verify the model dir is
  ~1.6 GB with **no `*.incomplete`** files (a partial `model.bin` segfaults CTranslate2 and restarts the
  container), and (2) a **slow first inference** right after a fresh pull. If a *complete* model still
  misbehaves, last-resort fallback is CPU (`-e WHISPER__INFERENCE_DEVICE=cpu`), slower but reliable.

## Self-Hosted STREAMING STT (sherpa-onnx)

`STT_PROVIDER=sherpa` runs a **self-hosted, in-process streaming** speech-to-text via
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (k2-fsa). Unlike Speaches/Whisper (batch — buffer
the whole utterance, then transcribe, no interim results), sherpa transcribes **as the caller speaks**
and emits interim transcripts — removing the post-speech batch wait and re-enabling the semantic turn
detector. It needs **no server, no Docker, no GPU**: it runs inside the agent worker through the
`sherpa-onnx-node` native addon and is real-time on CPU (RTF ~0.06, ~16× real-time). **STT only** — the
TTS leg is unaffected (`TTS_PROVIDER` still picks ElevenLabs or Speaches Kokoro).

### 1. Install the addon
Already in `package.json` (`npm install` pulls it, with a prebuilt Windows binary — no compilation).

### 2. Download a streaming English model
Stored under `models/` (gitignored). `tar` ships with Windows 10/11:
```bash
mkdir models && cd models
curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-21.tar.bz2
tar -xjf sherpa-onnx-streaming-zipformer-en-2023-06-21.tar.bz2
```
This yields `models/sherpa-onnx-streaming-zipformer-en-2023-06-21/` with `encoder/decoder/joiner*.onnx`
+ `tokens.txt` (the filenames the `SHERPA_STT_*` env defaults expect). The `2023-06-21` model is trained
on LibriSpeech + **GigaSpeech** (robust to varied/phone audio); the int8 files are the smaller/faster default.

#### Alternative: streaming paraformer (`SHERPA_STT_MODEL_TYPE=paraformer`)
A second model family is supported — the FunASR streaming **paraformer** (encoder + decoder, **no
joiner**, so the recognizer config key differs; the module handles it). The available streaming
paraformer is **bilingual zh-en**, i.e. Chinese-first with English as a *minority* of the training
data — so for English phone audio it may be **worse** than the English-specialised zipformer. A/B it
before trusting it. Download:
```bash
cd models
curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
tar -xjf sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
```
Then set `SHERPA_STT_MODEL_TYPE=paraformer`, `SHERPA_STT_MODEL_DIR=./models/sherpa-onnx-streaming-paraformer-bilingual-zh-en`,
`SHERPA_STT_ENCODER=encoder.int8.onnx`, `SHERPA_STT_DECODER=decoder.int8.onnx` (the `.env` ships these
ready to uncomment). Note the int8 encoder is ~158 MB (vs the zipformer's tens of MB), so prewarm/RAM
are heavier.

### 3. Validate before going live (smoke test)
```bash
node scripts/sherpaSmokeTest.mjs                                  # bundled 16 kHz English sample
node scripts/sherpaSmokeTest.mjs models/.../test_wavs/8k.wav      # 8 kHz phone-rate sample
```
It prints partial transcripts, the final, and the RTF. Confirm English accuracy + RTF < 1 before wiring
it into a call.

### 4. Point the agent at sherpa
Set `STT_PROVIDER=sherpa` and the `SHERPA_STT_*` paths in `.env` (see the env reference), then
`npm run agent`. The ~190 MB model loads once in the worker's **prewarm** (not per call), so the first
caller turn isn't cold.

### Notes & caveats

- **Streaming vs batch.** Because sherpa emits interim transcripts, turn-taking uses the semantic
  `TurnDetector` (like ElevenLabs), **not** the VAD-only path Speaches falls back to. sherpa does its own
  endpoint detection (`rule1/2/3MinTrailingSilence`) to segment utterances.
- **Resampling.** Telephony is 8 kHz; the model wants 16 kHz. The `@livekit/agents` `SpeechStream` base
  auto-resamples (we pass `sampleRate:16000`), so no extra dependency — the module just converts
  Int16→Float32 for `acceptWaveform`.
- **English-first.** This model is English (LibriSpeech/GigaSpeech). For other languages swap in a
  different sherpa streaming model and update the `SHERPA_STT_*` paths.
- **No GPU needed.** CPU is real-time; this sidesteps the Whisper/Blackwell GPU saga entirely.

## Self-Hosted OFFLINE STT (sherpa-onnx SenseVoice)

`STT_PROVIDER=sensevoice` runs a **self-hosted, in-process OFFLINE (batch)** STT via sherpa-onnx
**SenseVoice**. Unlike the streaming sherpa path, this is a *non-streaming* recognizer — the in-process
counterpart to Speaches/Whisper, meant as a **faster A/B target vs Whisper while keeping accuracy**.
SenseVoice does a single **non-autoregressive** forward pass per utterance (no token-by-token LLM
decoding), so it's fast on CPU. It needs **no server, no Docker, no GPU**. **STT only** — TTS is unaffected.

Because it's batch (no interim transcripts), it plugs in like Speaches: wrapped in `stt.StreamAdapter` +
the shared VAD, so turn-taking uses the VAD path (**no semantic turn detector, no PREFLIGHT** — those are
the streaming providers).

### 1. Download the model
Stored under `models/` (gitignored). HuggingFace serves files individually (no tarball):
```bash
mkdir -p models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09
cd models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09
curl.exe -L -O https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09/resolve/main/model.onnx
curl.exe -L -O https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2025-09-09/resolve/main/tokens.txt
```
This repo ships **fp32 `model.onnx` (~930 MB) only** (no int8). It's the canonical 5-language SenseVoice-Small
(zh/en/ja/ko/yue); we pin `SENSEVOICE_LANGUAGE=en`.

### 2. Validate before going live (smoke test)
```bash
node scripts/senseVoiceSmokeTest.mjs models/sherpa-onnx-streaming-zipformer-en-2023-06-21/test_wavs/8k.wav
```
It prints the transcript + RTF. Confirm clean English (no Chinese chars) and RTF well under the Whisper
~0.7 s budget before wiring it into a call.

### 3. Point the agent at SenseVoice
Set `STT_PROVIDER=sensevoice` and the `SENSEVOICE_*` paths in `.env`, then `npm run agent`. The ~930 MB
model loads once in the worker's **prewarm** (not per call), so the first caller turn isn't cold.

### Notes & caveats
- **Batch, not streaming.** No PREFLIGHT / no semantic turn detection on this path — the win vs Whisper is
  the fast in-process single-pass decode (no Docker round-trip, no autoregression), not turn-taking.
- **fp32 weight.** ~930 MB load/RAM (the worker logs a ~2.6 GB advisory). If memory is tight, the int8
  `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8` tarball is a drop-in (repoint the dir/file).
- **Language pin.** `SENSEVOICE_LANGUAGE=en` keeps it on English so it won't drift to Chinese like the
  paraformer did. Codes: `auto|zh|en|ja|ko|yue`.

## Self-Hosted TTS (Chatterbox)

`TTS_PROVIDER=chatterbox` drives a **self-hosted [Chatterbox](https://github.com/devnen/Chatterbox-TTS-Server)**
(Resemble AI, MIT) TTS server — chosen as a **higher-quality A/B target vs Speaches/Kokoro**. It runs on the
**GPU** as a separate process (not in-process, not the Speaches container). **TTS only** — STT is unaffected.

Chatterbox exposes an OpenAI-compatible `POST /v1/audio/speech`, but **only supports `wav`/`opus`/`mp3` — no
`pcm`**, while LiveKit's stock `openai.TTS` plugin hardcodes `response_format: "pcm"`. So this leg uses a small
**custom client** ([src/chatterboxTts.mjs](src/chatterboxTts.mjs)) that requests `wav` (24 kHz mono pcm_16),
strips the RIFF header, and streams the PCM. It's a batch TTS auto-wrapped for per-sentence synthesis, like Kokoro.

### 1. Run the Chatterbox server
The server lives **outside this repo** (sibling clone). Start it manually before placing a call:
```powershell
cd ../Chatterbox-TTS-Server
.\venv\Scripts\python.exe server.py     # or: .\start.bat  — Web UI at http://localhost:8004/
```
It loads the model at boot (`chatterbox-turbo`). Stop with `Ctrl+C`.

### 2. Point the agent at Chatterbox
Set `TTS_PROVIDER=chatterbox` and the `CHATTERBOX_*` vars in `.env` (see the env reference), then `npm run agent`.
The voice is a predefined-voice **filename** (e.g. `Emily.wav` — must include `.wav`). The worker fires a
**warm-up** synthesis before the greeting (the first synth pays a ~8.6 s CUDA-kernel warmup that would otherwise
trip the pipeline's first-frame timeout).

### Notes & caveats
- **wav-only, custom client.** Unlike Kokoro (stock `openai.TTS`), Chatterbox needs the custom adapter because
  the plugin won't parse a WAV container — see the module header for the full why.
- **Latency.** Higher quality than Kokoro but slower per-synth (warm RTF ≈ 0.7). Per-sentence streaming + the
  pre-greeting warm-up hide most of it; if it's still too slow on calls, the lever is the server's streaming
  `/tts` endpoint (out of scope here).
- **Separate lifecycle.** The server is a process you start/stop yourself; if it's down, the first turn errors
  (same failure mode as Speaches being down). `CHATTERBOX_BASE_URL` must end in `/v1`.

## Self-Hosted TTS (Pocket)

`TTS_PROVIDER=pocket` drives **self-hosted [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts)**
(100M params, MIT) — a **CPU-only** TTS with voice cloning. Its draw here is that it runs entirely on the
**CPU**, freeing the GPU for STT and sidestepping the 8 GB VRAM contention the GPU TTS options
(Chatterbox/VoxCPM) hit. **TTS only** — STT is unaffected.

Unlike Chatterbox/VoxCPM, Pocket needs **no custom client**: it's served behind a community
**OpenAI-compatible server** ([teddybear082/pocket-tts-openai_streaming_server](https://github.com/teddybear082/pocket-tts-openai_streaming_server))
whose `POST /v1/audio/speech` emits **24 kHz mono PCM** — exactly what LiveKit's stock `openai.TTS` plugin
expects — so this leg reuses the same `openai.TTS` path as Speaches/Kokoro.

### 1. Run the Pocket server
The server lives **outside this repo** (sibling clone). One-time setup + start:
```powershell
git clone https://github.com/teddybear082/pocket-tts-openai_streaming_server ../pocket-tts-server
cd ../pocket-tts-server
python -m venv venv; .\venv\Scripts\pip install -r requirements.txt   # CPU PyTorch is enough
.\venv\Scripts\python.exe server.py                                    # listens on :49112
```
First run downloads the ~100M model. Stop with `Ctrl+C`.

### 2. Point the agent at Pocket
Set `TTS_PROVIDER=pocket` and the `POCKET_*` vars in `.env` (see the env reference), then `npm run agent`.
`POCKET_TTS_VOICE` is either a **built-in voice name** (`alba`, `giovanni`, `lola`, …) or a **cloned-voice
filename** — to clone, drop a clean 5–20 s `.wav` in the server's voices dir and name it here. The worker
fires a **warm-up** synthesis before the greeting so the CPU model load doesn't trip the first-frame timeout.

### Notes & caveats
- **CPU-only, no VRAM.** The whole point: pair it with GPU whisper STT and the card is used by STT alone.
  Avoid pairing with a CPU STT (sherpa/SenseVoice) under load — they'd contend for cores.
- **~real-time on this CPU.** Faster than real-time on an M4, ~real-time on an Intel Core Ultra 7; per-sentence
  streaming + the warm-up keep it under LiveKit's ~10 s stall watchdog, but watch felt latency.
- **English-only** at present. **Third-party server** (community repo, MIT) — runs local-only. `POCKET_BASE_URL`
  must end in `/v1`.

## Self-Hosted TTS (VibeVoice-Realtime)

`TTS_PROVIDER=vibevoice` drives **self-hosted [VibeVoice-Realtime-0.5B](https://github.com/microsoft/VibeVoice)**
(Microsoft, MIT weights) — a 0.5B streaming TTS that needs only **~2.5 GB VRAM**, far less than
Chatterbox/VoxCPM. **R&D only** (see caveats). **TTS only** — STT is unaffected.

Upstream ships **no OpenAI-compatible server** (just a websocket demo), and the community Docker
server needs CUDA 13 / driver ≥ 580. So this repo's integration uses a **thin shim we wrote**,
`VibeVoice/demo/openai_server.py`, which reuses the demo's own `StreamingTTSService` and exposes the
model's native **24 kHz mono PCM** at `POST /v1/audio/speech`. That's what the stock `openai.TTS`
plugin expects, so — as with Speaches/Pocket — there's **no custom client** in `src/`.

### 1. Run the shim
The VibeVoice checkout lives **outside this repo** (sibling clone). One-time setup:
```powershell
cd ../VibeVoice
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install --upgrade pip                                   # bundled pip 23 rejects newer wheel metadata
pip install "torch==2.8.*" "torchaudio==2.8.*" --index-url https://download.pytorch.org/whl/cu128
pip install -e ".[streamingtts]"
```
Then start it (loads the model at boot; `Ctrl+C` to stop):
```powershell
python demo\openai_server.py --port 8020
```
Interactive docs at <http://localhost:8020/docs>; voices at `GET /v1/audio/voices`.

### 2. Point the agent at VibeVoice
Set `TTS_PROVIDER=vibevoice` and the `VIBEVOICE_*` vars in `.env`, then `npm run agent`. The worker
fires a **warm-up** synthesis before the greeting (first CUDA/diffusion pass pays kernel warmup).

### Notes & caveats
- **No voice cloning.** Voices are fixed presets — `en-Carter_man`, `en-Davis_man`, `en-Emma_woman`,
  `en-Frank_man`, `en-Grace_woman`, `en-Mike_man`. The branded ElevenLabs voice is **not** reproducible
  here. The shim returns **400** on an unknown voice rather than silently substituting a default
  (upstream's fallback once turned a typo into a German voice).
- **Research license.** Microsoft: *"We do not recommend using VibeVoice in commercial or real-world
  applications without further testing"* — and they pulled the original repo once over misuse. Fine for
  A/B research; **not** a basis for a client-facing demo.
- **Don't run the shim and the GUI demo together** — each loads its own copy of the model (~2.5 GB VRAM).
- **Quality/speed knobs** are env vars on the shim: `CFG_SCALE` (1.5) and `INFERENCE_STEPS` (5; the
  model config's own default is 20 — cleaner but slower).
- **No flash-attn needed** (it isn't a dependency); the model falls back to SDPA automatically.
- English-only; unstable on inputs of ≤3 words. `VIBEVOICE_BASE_URL` must end in `/v1`.

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
| `STT_PROVIDER` | No | **Optional local override** for the STT leg (`elevenlabs`/`speaches`/`sherpa`/`sensevoice`). Selection is normally per-call via ServeAI `phoneCallConfig.liveKitSTT`; this only applies when the config omits it. Also warm-preloads sherpa/SenseVoice in prewarm when set. |
| `TTS_PROVIDER` | No | **Optional local override** for the TTS leg (`elevenlabs`/`speaches`/`chatterbox`/`voxcpm`/`pocket`). Selection is normally per-call via ServeAI `phoneCallConfig.liveKitTTS`; this only applies when the config omits it. |
| `SPEACHES_BASE_URL` | If `speaches` | Speaches OpenAI API base — **must end in `/v1`** (e.g. `http://localhost:8000/v1`) |
| `SPEACHES_API_KEY` | No | Speaches auth token; any non-empty string (e.g. `speaches`) unless auth is enabled |
| `SPEACHES_STT_MODEL` | If STT `speaches` | Whisper model ID (e.g. `Systran/faster-whisper-base`) |
| `SPEACHES_STT_LANGUAGE` | No | ISO language code for STT (defaults to `en` if unset) |
| `SPEACHES_TTS_MODEL` | If TTS `speaches` | TTS model ID (e.g. `speaches-ai/Kokoro-82M-v1.0-ONNX`) |
| `SPEACHES_TTS_VOICE` | If TTS `speaches` | TTS voice (e.g. `af_heart`) |
| `CHATTERBOX_BASE_URL` | If TTS `chatterbox` | Chatterbox OpenAI API base — **must end in `/v1`** (e.g. `http://localhost:8004/v1`) |
| `CHATTERBOX_API_KEY` | No | Dummy token; Chatterbox has no auth (any string, e.g. `chatterbox`) |
| `CHATTERBOX_TTS_MODEL` | If TTS `chatterbox` | Model name in the request (e.g. `chatterbox-turbo`); the loaded model is fixed server-side |
| `CHATTERBOX_TTS_VOICE` | If TTS `chatterbox` | Predefined-voice **filename**, must include `.wav` (e.g. `Emily.wav`) |
| `POCKET_BASE_URL` | If TTS `pocket` | Pocket server OpenAI API base — **must end in `/v1`** (e.g. `http://localhost:49112/v1`) |
| `POCKET_API_KEY` | No | Dummy token; the Pocket server has no auth (any string, e.g. `pocket`) |
| `POCKET_TTS_MODEL` | No | Model name in the request (default `pocket-tts`); ignored server-side |
| `POCKET_TTS_VOICE` | If TTS `pocket` | Built-in voice name (`alba`, …) or a cloned-voice filename in the server's voices dir |
| `VIBEVOICE_BASE_URL` | If TTS `vibevoice` | VibeVoice shim OpenAI API base — **must end in `/v1`** (e.g. `http://localhost:8020/v1`) |
| `VIBEVOICE_API_KEY` | No | Dummy token; the shim has no auth (any string, e.g. `vibevoice`) |
| `VIBEVOICE_TTS_MODEL` | No | Model name in the request (default `vibevoice-realtime`); ignored server-side |
| `VIBEVOICE_TTS_VOICE` | If TTS `vibevoice` | Fixed preset stem, e.g. `en-Emma_woman` (no cloning; unknown names 400) |
| `SHERPA_STT_MODEL_TYPE` | No | `transducer` (zipformer, default) or `paraformer` (FunASR zh-en; encoder+decoder, no joiner) |
| `SHERPA_STT_MODEL_DIR` | If STT `sherpa` | Folder holding the extracted streaming model (path from project root) |
| `SHERPA_STT_ENCODER` / `_DECODER` / `_JOINER` / `_TOKENS` | No | Model filenames within the dir (defaults are type-aware; paraformer ignores `_JOINER`) |
| `SHERPA_STT_NUM_THREADS` | No | Decode threads (default `2`) |
| `SHERPA_STT_LANGUAGE` | No | Language tag attached to transcripts (default `en`) |
| `SENSEVOICE_MODEL_DIR` | If STT `sensevoice` | Folder holding the SenseVoice model (path from project root) |
| `SENSEVOICE_MODEL` / `_TOKENS` | No | Model filenames within the dir (default `model.onnx` / `tokens.txt`) |
| `SENSEVOICE_LANGUAGE` | No | Forced language `auto\|zh\|en\|ja\|ko\|yue` (default `en`) |
| `SENSEVOICE_NUM_THREADS` | No | Decode threads (default `2`) |
| `SENSEVOICE_USE_ITN` | No | Inverse text normalization, `1`/`0` (default `1`) |
