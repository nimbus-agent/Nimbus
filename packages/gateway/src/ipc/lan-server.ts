import type { Socket, TCPSocketListener } from "bun";
import { isLoopbackHost } from "../llm/base-url-locality.ts";
import { registerListener } from "../locality/listener-registry.ts";
import type { BoxKeypair } from "./lan-crypto.ts";
import {
  type LegacyServerContext,
  legacyHandleEncrypted,
  legacyHandleHandshake,
} from "./lan-legacy.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import {
  MAX_LOGICAL_MESSAGE,
  MAX_RECORD_FRAME,
  openResponderHandshake,
  type Session,
  V2_FIRST_BYTE,
} from "./lan-session.ts";
import {
  type LanPeerMatch,
  MAX_ENCRYPTED_FRAME,
  MAX_HANDSHAKE_FRAME,
  MAX_PENDING_BYTES,
  type PairingService,
  type RateLimiterService,
  writeFramedBytes,
} from "./lan-wire.ts";
import {
  createQueuedSocketWriter,
  type QueuedSocketWriter,
} from "./server/queued-socket-writer.ts";

export type { LanPeerMatch, PairingService, RateLimiterService };
export { MAX_ENCRYPTED_FRAME, MAX_HANDSHAKE_FRAME, MAX_PENDING_BYTES };

export interface LanServerOptions {
  bind: string;
  port: number;
  hostKeypair: BoxKeypair;
  onMessage: (method: string, params: unknown, peer: LanPeerMatch) => Promise<unknown>;
  isKnownPeer: (pubkey: Uint8Array) => LanPeerMatch | null;
  registerPeer: (pubkey: Uint8Array, peerIp: string) => string;
  rateLimit: RateLimiterService;
  pairing: PairingService;
  /** `[lan] min_protocol`: 2 refuses the v1 wire for every peer. Default 1 (OR-FS-1). */
  minProtocol?: 1 | 2;
  /** D-FS-11: a socket that has not finished its handshake in this long is closed and counted. Default 10,000. */
  handshakeDeadlineMs?: number;
  /**
   * Called when a peer completes a v2 session and its recorded protocol was not yet 2, BEFORE message 2
   * is sent: the downgrade ratchet write (invariant I56). If it throws, the session is refused.
   */
  onPeerNegotiated?: (pubkey: Uint8Array) => void;
}

export const DEFAULT_HANDSHAKE_DEADLINE_MS = 10_000;
/** A legacy (v1) first frame is JSON, so its first byte is `{`. */
const LEGACY_FIRST_BYTE = 0x7b;

/** Which wire a connection speaks, fixed by its first byte (D-FS-9). */
type WireMode = "unknown" | "legacy" | "v2";

interface SessionState {
  mode: WireMode;
  peerPubkey?: Uint8Array;
  peerMatch?: LanPeerMatch;
  /** The v2 transport once message 2 was sent. */
  v2?: Session;
  /** True while this socket's drain task is running (see `handleChunk`). */
  draining?: boolean;
  /** D-FS-11: closes a socket that never finishes its handshake. */
  handshakeTimer?: ReturnType<typeof setTimeout> | undefined;
  peerIp: string;
  buffer: Uint8Array;
  /** Every write and end goes through this; Bun's raw `write()` drops what the kernel refuses. */
  writer: QueuedSocketWriter;
}

export class LanServer {
  private instance: TCPSocketListener<SessionState> | undefined;
  private unregisterListener: (() => void) | undefined;

  constructor(private readonly opts: LanServerOptions) {}

  /** What the legacy (v1) handlers read: the options plus the resolved `min_protocol`. */
  private legacyContext(): LegacyServerContext {
    return { ...this.opts, minProtocol: this.opts.minProtocol ?? 1 };
  }

  // start()/stop() do synchronous work behind a Promise contract their callers await; `Promise.try`
  // keeps a failure (e.g. a bind error from `Bun.listen`) a rejection rather than a synchronous throw.
  start(): Promise<void> {
    return Promise.try(() => {
      this.instance = Bun.listen<SessionState>({
        hostname: this.opts.bind,
        port: this.opts.port,
        socket: {
          open: (socket) => {
            socket.data = {
              mode: "unknown",
              peerIp: socket.remoteAddress,
              buffer: new Uint8Array(0),
              writer: createQueuedSocketWriter(socket),
            };
            this.armHandshakeDeadline(socket);
          },
          drain: (socket) => {
            socket.data.writer.flush();
          },
          data: (socket, chunk) => {
            void this.handleChunk(socket, chunk);
          },
          close: (socket) => {
            clearTimeout(socket.data.handshakeTimer);
          },
          error: (socket) => {
            clearTimeout(socket.data.handshakeTimer);
          },
        },
      });
      this.unregisterListener = registerListener(() => {
        const a = this.listenAddr();
        return a === undefined
          ? null
          : {
              name: "lan",
              address: `${a.host}:${String(a.port)}`,
              loopback: isLoopbackHost(a.host),
            };
      });
    });
  }

  stop(): Promise<void> {
    return Promise.try(() => {
      this.instance?.stop(true);
      this.instance = undefined;
      this.unregisterListener?.();
      this.unregisterListener = undefined;
    });
  }

  listenAddr(): { host: string; port: number } | undefined {
    if (!this.instance) return undefined;
    return { host: this.opts.bind, port: this.instance.port };
  }

  private async handleChunk(socket: Socket<SessionState>, chunk: Uint8Array): Promise<void> {
    // A terminal decision ends the socket only once its last reply has drained, so input can still
    // arrive in between. Nothing after that decision may be parsed: a rejected session must not go
    // on to pair, say hello or dispatch.
    if (socket.data.writer.isEnding()) return;
    if (!this.appendChunk(socket, chunk)) return;
    // ONE drain task per socket: a later chunk only appends bytes (above, capped) and the running task
    // picks them up, so request B is never dispatched while request A (a consent wait) is in flight,
    // and replies keep the order of requests.
    if (socket.data.draining === true) return;
    socket.data.draining = true;
    try {
      await this.drainFrames(socket);
    } finally {
      socket.data.draining = false;
    }
  }

  private async drainFrames(socket: Socket<SessionState>): Promise<void> {
    while (socket.data.buffer.length >= 4) {
      // Re-checked every pass: the previous frame (or an await inside it) may have ended the session.
      if (socket.data.writer.isEnding()) return;
      const payload = this.takeFrame(socket);
      if (payload === undefined) return;

      await this.dispatchFrame(socket, payload); // NOSONAR S9382: sequential by design - frames are a stream: the handshake sets the session state the next frame is read with, and a peer's RPCs (which can raise consent prompts) are answered one at a time, in order
    }
  }

  /** D-FS-11: arms the timer that closes a socket which has not finished its handshake. */
  private armHandshakeDeadline(socket: Socket<SessionState>): void {
    const ms = this.opts.handshakeDeadlineMs ?? DEFAULT_HANDSHAKE_DEADLINE_MS;
    socket.data.handshakeTimer = setTimeout(() => {
      if (socket.data.writer.isEnding()) return;
      this.opts.rateLimit.recordFailure(socket.data.peerIp);
      socket.data.writer.end();
    }, ms);
  }

  private clearHandshakeDeadline(socket: Socket<SessionState>): void {
    clearTimeout(socket.data.handshakeTimer);
    socket.data.handshakeTimer = undefined;
  }

  /** Routes one frame by the wire mode the connection first byte chose (D-FS-9). */
  private async dispatchFrame(socket: Socket<SessionState>, payload: Uint8Array): Promise<void> {
    const state = socket.data;
    if (state.mode === "unknown") {
      const first = payload[0];
      if (first === LEGACY_FIRST_BYTE) state.mode = "legacy";
      else if (first === V2_FIRST_BYTE) state.mode = "v2";
      else {
        this.opts.rateLimit.recordFailure(state.peerIp);
        state.writer.end();
        return;
      }
    }
    if (state.mode === "v2") {
      if (state.v2 === undefined) this.handleV2Handshake(socket, payload);
      else await this.handleV2Record(socket, state.v2, payload);
      return;
    }
    if (state.peerPubkey) {
      await this.handleEncryptedMessage(socket, payload);
      return;
    }
    this.handleHandshake(socket, payload);
    if (state.peerPubkey) this.clearHandshakeDeadline(socket);
  }

  /** Appends `chunk` to the session buffer; `false` (session ended) when it would exceed the cap. */
  private appendChunk(socket: Socket<SessionState>, chunk: Uint8Array): boolean {
    const prev = socket.data.buffer;
    if (prev.length + chunk.length > MAX_PENDING_BYTES) {
      socket.data.writer.end();
      return false;
    }
    const merged = new Uint8Array(prev.length + chunk.length);
    merged.set(prev, 0);
    merged.set(chunk, prev.length);
    socket.data.buffer = merged;
    return true;
  }

  /**
   * Removes and returns the next complete frame's payload from a buffer holding at least its
   * 4-byte length prefix. `undefined` when the frame is not complete yet, or when its declared
   * length is over the cap — then the session is ended (and a handshake failure recorded).
   */
  private takeFrame(socket: Socket<SessionState>): Uint8Array | undefined {
    const view = new DataView(
      socket.data.buffer.buffer,
      socket.data.buffer.byteOffset,
      socket.data.buffer.byteLength,
    );
    const length = view.getUint32(0, false);
    const cap = this.frameCap(socket.data);
    if (length > cap) {
      if (!this.handshakeDone(socket.data)) {
        this.opts.rateLimit.recordFailure(socket.data.peerIp);
      }
      socket.data.writer.end();
      return undefined;
    }
    if (socket.data.buffer.length < 4 + length) return undefined;
    const payload = socket.data.buffer.slice(4, 4 + length);
    socket.data.buffer = socket.data.buffer.slice(4 + length);
    return payload;
  }

  private handshakeDone(state: SessionState): boolean {
    return state.mode === "v2" ? state.v2 !== undefined : state.peerPubkey !== undefined;
  }

  /** The largest frame a connection may declare: 4,096 until its handshake is done, then by wire mode. */
  private frameCap(state: SessionState): number {
    if (!this.handshakeDone(state)) return MAX_HANDSHAKE_FRAME;
    return state.mode === "v2" ? MAX_RECORD_FRAME : MAX_ENCRYPTED_FRAME;
  }

  /**
   * The v2 handshake as ORDERED steps (spec 5.3); each step is a visible line, because the order is
   * the security argument: nothing is computed for a locked-out address, nothing is answered to a
   * message that does not open or to an unknown sender, and the ratchet is written before the peer
   * is told the session exists.
   */
  private handleV2Handshake(socket: Socket<SessionState>, firstFrameBody: Uint8Array): void {
    const ip = socket.data.peerIp;
    // 1. rate limiter, before any DH: a locked-out address gets no bytes back.
    if (!this.opts.rateLimit.checkAllowed(ip)) {
      socket.data.writer.end();
      return;
    }
    // 2. open message 1: a bad header or a message that does not open closes silently, counted.
    let handshake: ReturnType<typeof openResponderHandshake>;
    try {
      handshake = openResponderHandshake(firstFrameBody, { s: this.opts.hostKeypair });
    } catch {
      this.opts.rateLimit.recordFailure(ip);
      socket.data.writer.end();
      return;
    }
    // 3. the decrypted initiator static key must belong to a known peer (anyone can build a valid
    //    message 1 under their own key; this lookup is what rejects an unknown sender).
    const match = this.opts.isKnownPeer(handshake.remoteStatic);
    if (!match) {
      this.opts.rateLimit.recordFailure(ip);
      socket.data.writer.end();
      return;
    }
    // 4. min_protocol: a v2 session satisfies every setting, so there is nothing to refuse here; the
    //    legacy path is where min_protocol and the ratchet bite (lan-legacy.ts legacyAllowedFor).
    // 5. the ratchet write, then message 2, then the session becomes live.
    let peerMatch = match;
    if (match.protoVersion !== 2) {
      try {
        this.opts.onPeerNegotiated?.(handshake.remoteStatic);
      } catch {
        socket.data.writer.end();
        return;
      }
      peerMatch = { ...match, protoVersion: 2 };
    }
    let accepted: ReturnType<typeof handshake.accept>;
    try {
      accepted = handshake.accept();
    } catch {
      this.opts.rateLimit.recordFailure(ip);
      socket.data.writer.end();
      return;
    }
    writeFramedBytes(socket.data.writer, accepted.message2);
    socket.data.peerMatch = peerMatch;
    socket.data.v2 = accepted.session;
    this.clearHandshakeDeadline(socket);
  }

  /**
   * One v2 record. A record that does not open (a replayed request, a corrupted one) ends the session
   * and is a counted failure for the address (D-FS-14); the method denylist still runs before
   * `onMessage`, exactly as on the v1 path.
   */
  private async handleV2Record(
    socket: Socket<SessionState>,
    session: Session,
    record: Uint8Array,
  ): Promise<void> {
    const peer = socket.data.peerMatch;
    if (peer === undefined) {
      socket.data.writer.end();
      return;
    }
    let message: Uint8Array | undefined;
    try {
      message = session.openRecord(record);
    } catch {
      this.opts.rateLimit.recordFailure(socket.data.peerIp);
      socket.data.writer.end();
      return;
    }
    if (message === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(message));
    } catch {
      socket.data.writer.end();
      return;
    }
    // `null` and every other non-object parse fine and must not reach a field read.
    const request = parsed as { id?: string | number; method?: unknown; params?: unknown } | null;
    if (typeof request !== "object" || request === null || typeof request.method !== "string") {
      socket.data.writer.end();
      return;
    }
    const response = await this.answerRpc(request.id, request.method, request.params, peer);
    this.writeV2Reply(socket, session, response);
  }

  private async answerRpc(
    id: string | number | undefined,
    method: string,
    params: unknown,
    peer: LanPeerMatch,
  ): Promise<{
    id: string | number | undefined;
    result?: unknown;
    error?: { code: string; message: string };
  }> {
    try {
      checkLanMethodAllowed(method, peer);
      return { id, result: await this.opts.onMessage(method, params, peer) };
    } catch (err) {
      if (err instanceof LanError) {
        return { id, error: { code: `ERR_${String(err.rpcCode)}`, message: err.message } };
      }
      const e = err as { code?: string; message?: string };
      return { id, error: { code: e.code ?? "ERR_INTERNAL", message: e.message ?? String(err) } };
    }
  }

  private writeV2Reply(socket: Socket<SessionState>, session: Session, response: object): void {
    let bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.length > MAX_LOGICAL_MESSAGE) {
      const { id } = response as { id?: string | number };
      bytes = new TextEncoder().encode(
        JSON.stringify({ id, error: { code: "ERR_REPLY_TOO_LARGE", message: "reply too large" } }),
      );
    }
    for (const record of session.sealMessage(bytes)) writeFramedBytes(socket.data.writer, record);
  }

  private handleHandshake(socket: Socket<SessionState>, payload: Uint8Array): void {
    legacyHandleHandshake(socket.data, this.legacyContext(), payload);
  }

  private handleEncryptedMessage(socket: Socket<SessionState>, frame: Uint8Array): Promise<void> {
    return legacyHandleEncrypted(socket.data, this.legacyContext(), frame);
  }
}
