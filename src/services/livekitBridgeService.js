/**
 * LiveKit Bridge Service — custom Twilio Media Streams <-> self-hosted LiveKit room.
 *
 * Replaces the Cloud-only Twilio Connector (connectTwilioCall) for a self-hosted
 * livekit-server, which has no Connector service (verified against the 1.13.1/master
 * OSS source). For each inbound call, Twilio opens a bidirectional Media Streams
 * WebSocket to this service (via the `<Connect><Stream>` TwiML the backend returns).
 * We then join the call's LiveKit room as a participant using @livekit/rtc-node and:
 *
 *   - publish the caller's audio INTO the room (as a SOURCE_MICROPHONE track, which
 *     is what the agent's room I/O reads as its STT input), and
 *   - play the agent's audio OUT to Twilio (subscribe to the agent's track, encode
 *     back to mu-law, send `media` frames).
 *
 * The agent itself is dispatched with the same per-call metadata as the Cloud path,
 * via AgentDispatchService (which IS present in the OSS server), so the worker
 * (agent.mjs) is unchanged.
 *
 * Reachability: Twilio reaches us over a single WSS (ngrok-friendly); all LiveKit
 * WebRTC media stays on localhost loopback to the self-hosted server. No SIP/UDP.
 *
 * CommonJS: @livekit/rtc-node is dual CJS/ESM, so requiring it from this CJS service
 * is fine.
 */

const WebSocket = require("ws");
const {
  Room,
  RoomEvent,
  AudioSource,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
} = require("@livekit/rtc-node");
const { AccessToken, AgentDispatchClient } = require("livekit-server-sdk");
const { twilioMediaToPcm, pcmToTwilioMedia } = require("../audioCodec");

// Twilio Media Streams are 8 kHz mono mu-law. We run the LiveKit side at the same
// rate; the server/agent resample internally as needed for STT/TTS.
const SAMPLE_RATE = 8000;
const CHANNELS = 1;
const FRAME_MS = 20; // Twilio's native frame size (160 samples / 160 bytes).
const AGENT_NAME = "serveai-poc"; // must match WorkerOptions.agentName in agent.mjs

class LiveKitBridgeService {
  constructor() {
    this.activeBridges = new Map(); // callSid -> { room, ws }
  }

  /**
   * Handle one Twilio Media Streams WS connection (one call).
   */
  handleConnection(ws) {
    console.log("LiveKit bridge: Twilio media stream connected");

    let callSid = null;
    let streamSid = null;
    let room = null;
    let audioSource = null;
    let closed = false;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      this.activeBridges.delete(callSid);
      try {
        if (room) await room.disconnect();
      } catch (e) {
        console.error("LiveKit bridge: room disconnect error:", e.message);
      }
      console.log(`LiveKit bridge: closed for call ${callSid}`);
    };

    // Pump the agent's subscribed audio track out to Twilio. AudioStream resamples
    // to 8 kHz mono and slices into 20 ms (160-sample) frames for us, so each frame
    // maps 1:1 to a Twilio `media` event.
    const pumpAgentAudio = async (track) => {
      const stream = new AudioStream(track, {
        sampleRate: SAMPLE_RATE,
        numChannels: CHANNELS,
        frameSizeMs: FRAME_MS,
      });
      const reader = stream.getReader();
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (ws.readyState !== WebSocket.OPEN || !streamSid) continue;
          const payload = pcmToTwilioMedia(value.data);
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
        }
      } catch (e) {
        if (!closed) console.error("LiveKit bridge: agent-audio pump error:", e.message);
      }
    };

    const handleStart = async (start) => {
      callSid = start.callSid;
      streamSid = start.streamSid;
      // Per-call config arrives as <Parameter> custom parameters. Read case-
      // insensitively since some Twilio paths lowercase the names.
      const cp = start.customParameters || {};
      const get = (k) => cp[k] ?? cp[k.toLowerCase()];
      const prompt = get("prompt");
      const greeting = get("greeting");
      const chatflowId = get("chatflowId");
      const callerNumber = get("callerNumber");
      // Per-call STT/TTS leg selection from ServeAI config — forwarded to the agent.
      const liveKitSTT = get("liveKitSTT");
      const liveKitTTS = get("liveKitTTS");
      const roomName = `call-${callSid}`;

      console.log(`LiveKit bridge: start call ${callSid} -> room ${roomName}`);

      // Mint a join token for this bridge participant.
      const at = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        { identity: `bridge-${callSid}`, name: "twilio-bridge" }
      );
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = await at.toJwt();

      // Join the room. Register the subscription handler before connecting so we
      // never miss the agent's track. Any subscribed audio track is the agent's
      // (1:1 room: bridge + agent).
      room = new Room();
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === TrackKind.KIND_AUDIO) pumpAgentAudio(track);
      });
      await room.connect(process.env.LIVEKIT_URL, token, {
        autoSubscribe: true,
        dynacast: false,
      });

      // Publish the caller's audio as the room's microphone input for the agent.
      audioSource = new AudioSource(SAMPLE_RATE, CHANNELS);
      const callerTrack = LocalAudioTrack.createAudioTrack("caller", audioSource);
      await room.localParticipant.publishTrack(
        callerTrack,
        new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
      );

      // Dispatch the agent into the room with the same metadata the Cloud path used.
      const dispatch = new AgentDispatchClient(
        process.env.LIVEKIT_URL,
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET
      );
      await dispatch.createDispatch(roomName, AGENT_NAME, {
        metadata: JSON.stringify({
          prompt,
          greeting,
          chatflowId,
          callSid,
          callerNumber,
          liveKitSTT,
          liveKitTTS,
        }),
      });

      this.activeBridges.set(callSid, { room, ws });
      console.log(`LiveKit bridge: agent dispatched for call ${callSid}`);
    };

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.event) {
        case "start":
          try {
            await handleStart(msg.start);
          } catch (e) {
            console.error(`LiveKit bridge: start failed for ${callSid}:`, e.message);
            await cleanup();
            ws.close();
          }
          break;

        case "media":
          // Caller speech in -> publish to the room. Fire-and-forget: the source
          // queue self-paces (Twilio sends in real time). Guard against the brief
          // window before the room/source is ready, and after teardown.
          if (!audioSource || closed) break;
          {
            const pcm = twilioMediaToPcm(msg.media.payload);
            const frame = new AudioFrame(pcm, SAMPLE_RATE, CHANNELS, pcm.length);
            audioSource.captureFrame(frame).catch(() => {});
          }
          break;

        case "stop":
          await cleanup();
          break;
      }
    });

    ws.on("close", cleanup);
    ws.on("error", (err) => {
      console.error("LiveKit bridge: WS error:", err.message);
      cleanup();
    });
  }
}

module.exports = new LiveKitBridgeService();
