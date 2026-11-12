/**
 * Pieces of the LAN transport shared by both wire versions and by both ends: the frame caps, the
 * service interfaces the server consumes, and the length-prefixed framing helpers. They live here,
 * not in `lan-server.ts` or `lan-client.ts`, so `lan-legacy.ts` (the v1 box path) and the v2 session
 * code can use them without importing each other's host file (no import cycle).
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
  consume(code: string): boolean;
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

/** Every `kind` a Nimbus responder sends is a short lowercase protocol token. */
const PROTOCOL_KIND = /^[a-z_]{1,32}$/;

/**
 * A handshake reply's `kind`, for an error message. The reply arrives BEFORE the responder's key is
 * checked, so anyone answering at the peer's address controls this text, and the message reaches
 * brief `## Gaps` and CLI output. Only a protocol token is echoed; anything else reads `unknown`.
 */
export function replyKindForMessage(kind: unknown): string {
  return typeof kind === "string" && PROTOCOL_KIND.test(kind) ? kind : "unknown";
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
 * One-shot settle guard shared by the single-frame and two-frame exchanges: starts the timeout
 * timer and returns a `finish(body?, err?)` that resolves/rejects exactly once (clearing the timer),
 * mapping a missing body to `closedMsg` and a timeout to `timeoutMsg`.
 *
 * Every caller settles BEFORE `socket.end()`, on the error paths as on the success path: Bun fires
 * `close()` synchronously inside `end()`, and `close()` calls `finish(undefined)` — so ending first
 * would replace the specific error (a bad hello, a pinned-key mismatch) with `closedMsg`.
 */
export function makeSettler(
  resolve: (body: Uint8Array) => void,
  reject: (err: Error) => void,
  timeoutMs: number,
  timeoutMsg: string,
  closedMsg: string,
): (body: Uint8Array | undefined, err?: Error) => void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const finish = (body: Uint8Array | undefined, err?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) reject(err);
    else if (body) resolve(body);
    else reject(new Error(closedMsg));
  };
  timer = setTimeout(() => finish(undefined, new Error(timeoutMsg)), timeoutMs);
  return finish;
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
