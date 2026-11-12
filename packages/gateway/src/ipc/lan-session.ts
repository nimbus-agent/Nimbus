/**
 * LAN v2 sessions (invariant I56): the records of a federation RPC are encrypted only under keys
 * derived by `lan-noise.ts` from a `Noise_IK_25519_AESGCM_SHA256` exchange in which BOTH sides
 * contribute an ephemeral DH key. The static identity key authenticates (through `es` and `ss`,
 * `ee` and `se`); it never encrypts a record.
 *
 * No socket code lives here: `lan-server.ts` and `lan-client.ts` own the sockets and call these
 * drivers with byte arrays. What this file owns:
 *
 *  - the first-frame header (`0x4E 0x4C 0x02 0x01`: "NL", version 2, pattern IK) and the prologue,
 *    so an edit to either breaks the handshake;
 *  - the records (flag byte, 65,518-byte chunks, the 4 MiB logical-message cap);
 *  - the in-session rekey, per CipherState, every `REKEY_EVERY_RECORDS` records (OR-FS-3).
 *
 * Message 1 and message 2 carry an EMPTY payload (D-FS-4): a first-message payload is encrypted
 * under static keys only, so it is neither forward-secret nor replay-proof. The request travels as
 * the first TRANSPORT record, after message 2.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import {
  type CipherState,
  HandshakeState,
  MAX_NOISE_MESSAGE,
  NOISE_OPEN_FAILED,
  PATTERN_IK,
} from "./lan-noise.ts";

/** OR-FS-3: each CipherState rekeys itself after this many records. */
export const REKEY_EVERY_RECORDS = 1024;
/** One logical message (a request or a reply) is at most this many bytes, as in the v1 transport. */
export const MAX_LOGICAL_MESSAGE = 4 * 1024 * 1024;
/** A record is a Noise transport message: flag byte + chunk + 16-byte tag <= 65,535. */
export const MAX_RECORD_CHUNK = MAX_NOISE_MESSAGE - 16 - 1;
/** The largest ciphertext of one record (what a frame may declare). */
export const MAX_RECORD_FRAME = MAX_NOISE_MESSAGE;

const FLAG_MORE = 0x00;
const FLAG_FINAL = 0x01;
const PATTERN_BYTE_IK = 0x01;
const VERSION = 0x02;
const MAGIC = [0x4e, 0x4c] as const;
const FIRST_FRAME_HEADER_LENGTH = 4;

/** D-FS-7: the only label of ours is the prologue; everything else is Noise's own schedule. */
const PROLOGUE = new Uint8Array([
  ...new TextEncoder().encode("nimbus-lan/2"),
  VERSION,
  PATTERN_BYTE_IK,
]);

export const SESSION_PROTOCOL_ERROR = "lan-session: protocol error";
export const SESSION_TOO_LARGE = "lan-session: message too large";
const EMPTY = new Uint8Array(0);

/** First byte of a v2 first frame; a legacy (JSON) first frame starts `0x7B`. */
export const V2_FIRST_BYTE = MAGIC[0];

/** The first frame body: header then Noise message 1. */
export function encodeFirstFrame(message1: Uint8Array): Uint8Array {
  const out = new Uint8Array(FIRST_FRAME_HEADER_LENGTH + message1.length);
  out.set([MAGIC[0], MAGIC[1], VERSION, PATTERN_BYTE_IK], 0);
  out.set(message1, FIRST_FRAME_HEADER_LENGTH);
  return out;
}

/** Noise message 1 of a v2 IK first frame; `undefined` for any other magic, version or pattern. */
export function decodeFirstFrame(body: Uint8Array): Uint8Array | undefined {
  const ok =
    body.length >= FIRST_FRAME_HEADER_LENGTH &&
    body[0] === MAGIC[0] &&
    body[1] === MAGIC[1] &&
    body[2] === VERSION &&
    body[3] === PATTERN_BYTE_IK;
  return ok ? body.subarray(FIRST_FRAME_HEADER_LENGTH) : undefined;
}

export interface SessionOptions {
  /** Records between rekeys. Production uses the default; a test varies one side to prove a desync fails. */
  rekeyEveryRecords?: number;
}

/**
 * The transport half of a v2 session. `sealMessage` turns one logical message into records;
 * `openRecord` takes records one at a time and returns the whole message on the final one. Any
 * error ends the session: the object refuses all further use.
 */
export class Session {
  private readonly rekeyEvery: bigint;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private dead = false;

  constructor(
    private readonly send: CipherState,
    private readonly receive: CipherState,
    opts: SessionOptions = {},
  ) {
    this.rekeyEvery = BigInt(opts.rekeyEveryRecords ?? REKEY_EVERY_RECORDS);
  }

  /** SHA-256 fingerprints of the two current keys: lets a test see a rekey without seeing a key. */
  keyFingerprints(): { send: string; receive: string } {
    return { send: this.send.keyFingerprint(), receive: this.receive.keyFingerprint() };
  }

  sealMessage(message: Uint8Array): Uint8Array[] {
    this.requireLive();
    if (message.length > MAX_LOGICAL_MESSAGE) {
      this.dead = true;
      throw new Error(SESSION_TOO_LARGE);
    }
    const records: Uint8Array[] = [];
    let offset = 0;
    do {
      const chunk = message.subarray(offset, offset + MAX_RECORD_CHUNK);
      offset += chunk.length;
      const plain = new Uint8Array(1 + chunk.length);
      plain[0] = offset >= message.length ? FLAG_FINAL : FLAG_MORE;
      plain.set(chunk, 1);
      records.push(this.guard(() => this.sealOne(plain)));
    } while (offset < message.length);
    return records;
  }

  /** Opens one record; the whole message once the final record arrives, else `undefined`. */
  openRecord(record: Uint8Array): Uint8Array | undefined {
    this.requireLive();
    const plain = this.guard(() => this.openOne(record));
    const flag = plain[0];
    if (plain.length === 0 || (flag !== FLAG_MORE && flag !== FLAG_FINAL)) {
      this.dead = true;
      throw new Error(SESSION_PROTOCOL_ERROR);
    }
    const chunk = plain.subarray(1);
    if (this.pendingBytes + chunk.length > MAX_LOGICAL_MESSAGE) {
      this.dead = true;
      throw new Error(SESSION_TOO_LARGE);
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (flag === FLAG_MORE) return undefined;
    const message = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      message.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    return message;
  }

  private requireLive(): void {
    if (this.dead) throw new Error(SESSION_PROTOCOL_ERROR);
  }

  /** Runs a cipher operation; any failure ends the session. */
  private guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (err) {
      this.dead = true;
      throw err;
    }
  }

  private sealOne(plain: Uint8Array): Uint8Array {
    const sealed = this.send.encryptWithAd(EMPTY, plain);
    if (this.send.nonce() % this.rekeyEvery === 0n) this.send.rekey();
    return sealed;
  }

  private openOne(record: Uint8Array): Uint8Array {
    const plain = this.receive.decryptWithAd(EMPTY, record);
    if (this.receive.nonce() % this.rekeyEvery === 0n) this.receive.rekey();
    return plain;
  }
}

export interface InitiatorOptions {
  s: BoxKeypair;
  /** The responder's static public key, from the pinned peer row. */
  rs: Uint8Array;
  /** Test-only pass-through to the Noise engine; production callers never set it. */
  generateEphemeral?: () => BoxKeypair;
}

export interface InitiatorHandshake {
  /** The first frame body to send: header and Noise message 1. */
  firstFrameBody: Uint8Array;
  /** Reads message 2 and returns the session; throws a fixed error when it does not open. */
  finish(message2: Uint8Array): Session;
}

export function createInitiatorHandshake(opts: InitiatorOptions): InitiatorHandshake {
  const hs = new HandshakeState({
    pattern: PATTERN_IK,
    initiator: true,
    prologue: PROLOGUE,
    s: opts.s,
    rs: opts.rs,
    generateEphemeral: opts.generateEphemeral,
  });
  const firstFrameBody = encodeFirstFrame(hs.writeMessage(EMPTY));
  return {
    firstFrameBody,
    finish(message2) {
      if (hs.readMessage(message2).length !== 0) throw new Error(NOISE_OPEN_FAILED);
      const { send, receive } = hs.split();
      return new Session(send, receive);
    },
  };
}

export interface ResponderOptions {
  s: BoxKeypair;
  /** Test-only pass-through to the Noise engine; production callers never set it. */
  generateEphemeral?: () => BoxKeypair;
}

export interface ResponderHandshake {
  /** The initiator's static public key, decrypted from message 1 (not yet authorised by anyone). */
  remoteStatic: Uint8Array;
  /** Writes message 2 and returns the session; call only after the peer is known and allowed. */
  accept(): { message2: Uint8Array; session: Session };
}

/**
 * Opens a first frame body. Throws one fixed error for a bad header, a message that does not open
 * and a message 1 that carries a payload (anyone can build a valid message 1 under their own
 * static key; it is `isKnownPeer` on `remoteStatic` that rejects an unknown sender).
 */
export function openResponderHandshake(
  firstFrameBody: Uint8Array,
  opts: ResponderOptions,
): ResponderHandshake {
  const message1 = decodeFirstFrame(firstFrameBody);
  if (message1 === undefined) throw new Error(NOISE_OPEN_FAILED);
  const hs = new HandshakeState({
    pattern: PATTERN_IK,
    initiator: false,
    prologue: PROLOGUE,
    s: opts.s,
    generateEphemeral: opts.generateEphemeral,
  });
  if (hs.readMessage(message1).length !== 0) throw new Error(NOISE_OPEN_FAILED);
  return {
    remoteStatic: hs.remoteStatic(),
    accept() {
      const message2 = hs.writeMessage(EMPTY);
      const { send, receive } = hs.split();
      return { message2, session: new Session(send, receive) };
    },
  };
}
