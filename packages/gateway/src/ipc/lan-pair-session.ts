/**
 * LAN v2 pairing (invariant I56, Phase 10 FS2): the `Noise_XXpsk0_25519_AESGCM_SHA256` exchange that
 * replaces the plaintext `pair` / `pair_ok` frames. The pairing code is never sent: both ends derive
 * a PSK from it (`derivePairingPsk`) and mix it in BEFORE the first DH, so a wrong or absent code
 * fails at MESSAGE 1, and a man in the middle who lacks it can finish neither direction.
 *
 *   prologue: "nimbus-lan/2" || 0x02 || 0x02
 *   -> psk, e         (message 1, EMPTY payload)
 *   <- e, ee, s, es   (message 2: the host's static key, encrypted)
 *   -> s, se          (message 3: the initiator's static key, encrypted)
 *
 * Both static keys are learned only here and only under the code: this is where a peer's key is
 * first trusted. After message 3 both sides `Split()`; the host then sends `{kind:"pair_ok", peer_id}`
 * as the first transport record, and the initiator persists the host only after it opens.
 *
 * Like `lan-session.ts`, no socket code lives here: `lan-pair-server.ts` and `lan-pair-client.ts`
 * own the sockets and call these drivers with byte arrays. Every failure to open is the one fixed
 * `NOISE_OPEN_FAILED`.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import { HandshakeState, NOISE_OPEN_FAILED, PATTERN_XXPSK0 } from "./lan-noise.ts";
import { PATTERN_BYTE_XXPSK0, Session, V2_MAGIC, V2_VERSION } from "./lan-session.ts";

const HEADER_LENGTH = 4;
const EMPTY = new Uint8Array(0);

/** D-FS-7: the prologue is the only label of ours; the pattern byte is inside it. */
export const PAIR_PROLOGUE = new Uint8Array([
  ...new TextEncoder().encode("nimbus-lan/2"),
  V2_VERSION,
  PATTERN_BYTE_XXPSK0,
]);

/** The first frame body of a pairing: header then Noise message 1. */
export function encodePairFirstFrame(message1: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + message1.length);
  out.set([V2_MAGIC[0], V2_MAGIC[1], V2_VERSION, PATTERN_BYTE_XXPSK0], 0);
  out.set(message1, HEADER_LENGTH);
  return out;
}

/** True when a v2 first frame asks for a pairing (`XXpsk0`) rather than a session (`IK`). */
export function isPairFirstFrame(body: Uint8Array): boolean {
  return body.length >= HEADER_LENGTH && body[3] === PATTERN_BYTE_XXPSK0;
}

function decodePairFirstFrame(body: Uint8Array): Uint8Array | undefined {
  const ok =
    body.length >= HEADER_LENGTH &&
    body[0] === V2_MAGIC[0] &&
    body[1] === V2_MAGIC[1] &&
    body[2] === V2_VERSION &&
    body[3] === PATTERN_BYTE_XXPSK0;
  return ok ? body.subarray(HEADER_LENGTH) : undefined;
}

export interface PairInitiatorOptions {
  s: BoxKeypair;
  /** `derivePairingPsk(code)`. */
  psk: Uint8Array;
  /** Test-only pass-through to the Noise engine; production callers never set it. */
  generateEphemeral?: (() => BoxKeypair) | undefined;
}

export interface PairInitiator {
  firstFrameBody: Uint8Array;
  /** Reads message 2, returns message 3, the host's static key and the transport session. */
  finish(message2: Uint8Array): {
    message3: Uint8Array;
    hostStatic: Uint8Array;
    session: Session;
  };
}

export function createPairInitiator(opts: PairInitiatorOptions): PairInitiator {
  const hs = new HandshakeState({
    pattern: PATTERN_XXPSK0,
    initiator: true,
    prologue: PAIR_PROLOGUE,
    s: opts.s,
    psks: [opts.psk],
    generateEphemeral: opts.generateEphemeral,
  });
  const firstFrameBody = encodePairFirstFrame(hs.writeMessage(EMPTY));
  return {
    firstFrameBody,
    finish(message2) {
      if (hs.readMessage(message2).length !== 0) throw new Error(NOISE_OPEN_FAILED);
      const message3 = hs.writeMessage(EMPTY);
      const hostStatic = hs.remoteStatic();
      const { send, receive } = hs.split();
      return { message3, hostStatic, session: new Session(send, receive) };
    },
  };
}

export interface PairResponderOptions {
  s: BoxKeypair;
  /** The open window's PSK (`PairingService.currentPsk()`). */
  psk: Uint8Array;
  generateEphemeral?: (() => BoxKeypair) | undefined;
}

export interface PairResponder {
  /** Message 2, to send now (message 1 opened, so the initiator holds the code). */
  message2: Uint8Array;
  /** Reads message 3; the initiator's static key and the transport session. */
  finish(message3: Uint8Array): { remoteStatic: Uint8Array; session: Session };
}

/**
 * Opens a pairing first frame body and writes message 2. Throws the one fixed error for a bad
 * header, a message 1 that does not open (a wrong or absent code) and one that carries a payload.
 */
export function openPairResponder(
  firstFrameBody: Uint8Array,
  opts: PairResponderOptions,
): PairResponder {
  const message1 = decodePairFirstFrame(firstFrameBody);
  if (message1 === undefined) throw new Error(NOISE_OPEN_FAILED);
  const hs = new HandshakeState({
    pattern: PATTERN_XXPSK0,
    initiator: false,
    prologue: PAIR_PROLOGUE,
    s: opts.s,
    psks: [opts.psk],
    generateEphemeral: opts.generateEphemeral,
  });
  if (hs.readMessage(message1).length !== 0) throw new Error(NOISE_OPEN_FAILED);
  const message2 = hs.writeMessage(EMPTY);
  return {
    message2,
    finish(message3) {
      if (hs.readMessage(message3).length !== 0) throw new Error(NOISE_OPEN_FAILED);
      const remoteStatic = hs.remoteStatic();
      const { send, receive } = hs.split();
      return { remoteStatic, session: new Session(send, receive) };
    },
  };
}
