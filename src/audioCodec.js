/**
 * Audio codec helpers for the Twilio <-> LiveKit bridge.
 *
 * Twilio Media Streams carry 8 kHz mono G.711 mu-law (PCMU) audio, base64-encoded
 * in each `media` frame. LiveKit's audio I/O works in linear PCM (Int16). These two
 * pure functions convert between the two representations; they hold no state and
 * touch no network/SDK, so they are unit-tested directly (tests/bridgeAudio.test.mjs).
 *
 * mu-law is a lossy 8-bit companding codec, but it is a *closed* 256-value mapping:
 * encode(decode(b)) === b for every byte b. That exactness is what the round-trip
 * test asserts.
 */

const { mulaw } = require("alawmulaw");

/**
 * Twilio media payload (base64 mu-law, 8 kHz) -> Int16 PCM samples for LiveKit.
 * One 20 ms Twilio frame is 160 bytes -> 160 samples.
 * @param {string} payloadBase64
 * @returns {Int16Array}
 */
function twilioMediaToPcm(payloadBase64) {
  const ulaw = Buffer.from(payloadBase64, "base64");
  return mulaw.decode(ulaw);
}

/**
 * Int16 PCM (8 kHz mono) -> Twilio media payload (base64 mu-law).
 * @param {Int16Array} int16
 * @returns {string} base64 mu-law
 */
function pcmToTwilioMedia(int16) {
  const ulaw = mulaw.encode(int16);
  return Buffer.from(ulaw).toString("base64");
}

module.exports = { twilioMediaToPcm, pcmToTwilioMedia };
