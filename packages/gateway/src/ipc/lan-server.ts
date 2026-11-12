import type { Socket, TCPSocketListener } from "bun";
import { isLoopbackHost } from "../llm/base-url-locality.ts";
import { registerListener } from "../locality/listener-registry.ts";
import type { BoxKeypair } from "./lan-crypto.ts";
import { legacyHandleEncrypted, legacyHandleHandshake } from "./lan-legacy.ts";
import {
  type LanPeerMatch,
  MAX_ENCRYPTED_FRAME,
  MAX_HANDSHAKE_FRAME,
  MAX_PENDING_BYTES,
  type PairingService,
  type RateLimiterService,
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
}

interface SessionState {
  peerPubkey?: Uint8Array;
  peerMatch?: LanPeerMatch;
  peerIp: string;
  buffer: Uint8Array;
  /** Every write and end goes through this; Bun's raw `write()` drops what the kernel refuses. */
  writer: QueuedSocketWriter;
}

export class LanServer {
  private instance: TCPSocketListener<SessionState> | undefined;
  private unregisterListener: (() => void) | undefined;

  constructor(private readonly opts: LanServerOptions) {}

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
              peerIp: socket.remoteAddress,
              buffer: new Uint8Array(0),
              writer: createQueuedSocketWriter(socket),
            };
          },
          drain: (socket) => {
            socket.data.writer.flush();
          },
          data: (socket, chunk) => {
            void this.handleChunk(socket, chunk);
          },
          close: () => {},
          error: () => {},
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

    while (socket.data.buffer.length >= 4) {
      // Re-checked every pass: the previous frame (or an await inside it) may have ended the session.
      if (socket.data.writer.isEnding()) return;
      const payload = this.takeFrame(socket);
      if (payload === undefined) return;

      if (socket.data.peerPubkey) {
        await this.handleEncryptedMessage(socket, payload); // NOSONAR S9382: sequential by design - frames are a stream: the handshake sets the session state the next frame is read with, and a peer's RPCs (which can raise consent prompts) are answered one at a time, in order
      } else {
        this.handleHandshake(socket, payload);
      }
    }
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
    const cap = socket.data.peerPubkey ? MAX_ENCRYPTED_FRAME : MAX_HANDSHAKE_FRAME;
    if (length > cap) {
      if (!socket.data.peerPubkey) {
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

  private handleHandshake(socket: Socket<SessionState>, payload: Uint8Array): void {
    legacyHandleHandshake(socket.data, this.opts, payload);
  }

  private handleEncryptedMessage(socket: Socket<SessionState>, frame: Uint8Array): Promise<void> {
    return legacyHandleEncrypted(socket.data, this.opts, frame);
  }
}
