/**
 * Pieces of the LAN transport shared by both ends: the frame caps, the
 * service interfaces the server consumes, and the length-prefixed framing helpers. They live here,
 * not in `lan-server.ts` or `lan-client.ts`, so the v2 session code, the pairing
 * code and the host files can use them without importing each other (no import cycle).
 * `lan-server.ts` and `lan-client.ts` re-export what their callers already import from them.
 */
import type { Socket } from "bun";
import {
  createQueuedSocketWriter,
  type QueuedSocketWriter,
} from "./server/queued-socket-writer.ts";

export const MAX_HANDSHAKE_FRAME = 4_096;
export const MAX_ENCRYPTED_FRAME = 4 * 1024 * 1024;
export const MAX_PENDING_BYTES = MAX_ENCRYPTED_FRAME + 65_536;
export const DEFAULT_TIMEOUT_MS = 5000;

export interface PairingService {
  isOpen(): boolean;
  /** D-FS-15: the open window's `XXpsk0` PSK (a copy), or `undefined` when closed or expired. */
  currentPsk(): Uint8Array | undefined;
  /** D-FS-15: closes the window after message 3 opened; `false` if it was already closed or expired. */
  consumeOpen(): boolean;
  open(code: string): void;
  close(): void;
  getExpiresAt(): number | undefined;
}

export interface RateLimiterService {
  checkAllowed(ip: string): boolean;
  recordFailure(ip: string): void;
  recordSuccess(ip: string): void;
}

export interface LanPeerMatch {
  peerId: string;
  writeAllowed: boolean;
  /**
   * The protocol this peer has completed with us: 2 once a Noise session did (the downgrade ratchet,
   * invariant I56), else 1. REQUIRED, never optional: an absent value read as 1 would fail open.
   */
  protoVersion: 1 | 2;
}

export interface FrameReader {
  push(chunk: Uint8Array): void;
  next(): Uint8Array | undefined;
}

/** Buffers a 4-byte-length-prefixed stream and yields one frame body at a time.
 * Rejects any advertised frame length exceeding maxFrameBytes before buffering. */
export function makeFrameReader(maxFrameBytes: number): FrameReader {
  let buf = new Uint8Array(0);
  return {
    push(chunk) {
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;
    },
    next() {
      if (buf.length < 4) return undefined;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const len = view.getUint32(0, false);
      if (len > maxFrameBytes) throw new Error("lan-client: oversized frame");
      if (buf.length < 4 + len) return undefined;
      const body = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      return body;
    },
  };
}

export function buildFrame(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  const out = new Uint8Array(4 + payload.length);
  out.set(header, 0);
  out.set(payload, 4);
  return out;
}

/**
 * One queued writer per outbound socket. Bun's raw `write()` sends only what the kernel accepts
 * right now and drops the rest, so a request frame larger than the free send buffer (an encrypted
 * federation RPC can be up to MAX_ENCRYPTED_FRAME) would reach the peer truncated and never parse.
 */
const writers = new WeakMap<Socket<undefined>, QueuedSocketWriter>();

function writerFor(socket: Socket<undefined>): QueuedSocketWriter {
  let w = writers.get(socket);
  if (w === undefined) {
    w = createQueuedSocketWriter(socket);
    writers.set(socket, w);
  }
  return w;
}

/** Call from a socket's `drain` handler. */
export function flushWriter(socket: Socket<undefined>): void {
  writers.get(socket)?.flush();
}

export function writeFrame(socket: Socket<undefined>, payload: Uint8Array): void {
  writerFor(socket).writeBytes(buildFrame(payload));
}

/** Server side: queues `payload` behind its 4-byte big-endian length. */
export function writeFramedBytes(writer: QueuedSocketWriter, payload: Uint8Array): void {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, false);
  writer.writeBytes(header);
  writer.writeBytes(payload);
}
