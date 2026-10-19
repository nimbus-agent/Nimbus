import type { Socket, TCPSocketListener } from "bun";
import { isLoopbackHost } from "../llm/base-url-locality.ts";
import { registerListener } from "../locality/listener-registry.ts";
import type { BoxKeypair } from "./lan-crypto.ts";
import {
  deriveLanSessionKey,
  generateBoxKeypair,
  LAN_PROTOCOL_VERSION,
  openSessionFrame,
  pairingProof,
  pairingProofMatches,
  sealSessionFrame,
} from "./lan-crypto.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import {
  createQueuedSocketWriter,
  type QueuedSocketWriter,
} from "./server/queued-socket-writer.ts";

export const MAX_HANDSHAKE_FRAME = 4_096;
export const MAX_ENCRYPTED_FRAME = 4 * 1024 * 1024;
export const MAX_PENDING_BYTES = MAX_ENCRYPTED_FRAME + 65_536;

export interface PairingService {
  isOpen(): boolean;
  /** Consume the open code if `matches(code)`, returning it; `null` when closed, expired or no match. */
  consumeMatching(matches: (code: string) => boolean): string | null;
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
}

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

/** An established v2 session: the per-connection key and each direction's next sequence number. */
interface LanSession {
  key: Uint8Array;
  rxSeq: number;
  txSeq: number;
}

interface SessionState {
  peerPubkey?: Uint8Array;
  peerMatch?: LanPeerMatch;
  session?: LanSession;
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
    const prev = socket.data.buffer;
    if (prev.length + chunk.length > MAX_PENDING_BYTES) {
      socket.data.writer.end();
      return;
    }
    const merged = new Uint8Array(prev.length + chunk.length);
    merged.set(prev, 0);
    merged.set(chunk, prev.length);
    socket.data.buffer = merged;

    while (socket.data.buffer.length >= 4) {
      // Re-checked every pass: the previous frame (or an await inside it) may have ended the session.
      if (socket.data.writer.isEnding()) return;
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
        return;
      }
      if (socket.data.buffer.length < 4 + length) return;
      const payload = socket.data.buffer.slice(4, 4 + length);
      socket.data.buffer = socket.data.buffer.slice(4 + length);

      if (socket.data.peerPubkey) {
        await this.handleEncryptedMessage(socket, payload); // NOSONAR S9382: sequential by design - frames are a stream: the handshake sets the session state the next frame is read with, and a peer's RPCs (which can raise consent prompts) are answered one at a time, in order
      } else {
        this.handleHandshake(socket, payload);
      }
    }
  }

  private handleHandshake(socket: Socket<SessionState>, payload: Uint8Array): void {
    let msg: {
      kind?: string;
      v?: number;
      client_pubkey?: string;
      client_eph?: string;
      proof?: string;
    };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as typeof msg;
    } catch {
      socket.data.writer.end();
      return;
    }
    if (msg.kind !== "pair" && msg.kind !== "hello") {
      socket.data.writer.end();
      return;
    }
    const errKind = msg.kind === "hello" ? "hello_err" : "pair_err";
    // A v1 peer (no `v`, a cleartext `pairing_code`, no ephemeral key) is refused outright rather
    // than served the old, replayable protocol.
    if (msg.v !== LAN_PROTOCOL_VERSION) {
      this.writeFrame(socket, JSON.stringify({ kind: errKind, reason: "protocol_version" }));
      socket.data.writer.end();
      return;
    }
    const clientPubkey = decodeKey(msg.client_pubkey);
    if (clientPubkey === null) {
      socket.data.writer.end();
      return;
    }

    const ip = socket.data.peerIp;
    if (!this.opts.rateLimit.checkAllowed(ip)) {
      this.writeFrame(socket, JSON.stringify({ kind: errKind }));
      socket.data.writer.end();
      return;
    }

    if (msg.kind === "pair") {
      this.handlePair(socket, clientPubkey, msg.proof);
      return;
    }
    this.handleHello(socket, clientPubkey, decodeKey(msg.client_eph));
  }

  /**
   * Pairing: the client proves it holds the open code without sending it, and the reply proves the
   * host holds it too, so the client can check the host key before pinning it. The pairing
   * connection carries no RPCs; the client opens a session with `hello` afterwards.
   */
  private handlePair(
    socket: Socket<SessionState>,
    clientPubkey: Uint8Array,
    proofB64: string | undefined,
  ): void {
    const ip = socket.data.peerIp;
    const proof = typeof proofB64 === "string" ? Buffer.from(proofB64, "base64") : null;
    const code =
      proof === null || !this.opts.pairing.isOpen()
        ? null
        : this.opts.pairing.consumeMatching((c) =>
            pairingProofMatches(pairingProof(c, "client", clientPubkey), new Uint8Array(proof)),
          );
    if (code === null) {
      this.opts.rateLimit.recordFailure(ip);
      this.writeFrame(socket, JSON.stringify({ kind: "pair_err" }));
      socket.data.writer.end();
      return;
    }
    const peerId = this.opts.registerPeer(clientPubkey, ip);
    this.opts.rateLimit.recordSuccess(ip);
    const hostPub = this.opts.hostKeypair.publicKey;
    this.writeFrame(
      socket,
      JSON.stringify({
        kind: "pair_ok",
        v: LAN_PROTOCOL_VERSION,
        host_pubkey: Buffer.from(hostPub).toString("base64"),
        host_proof: Buffer.from(pairingProof(code, "host", clientPubkey, hostPub)).toString(
          "base64",
        ),
        peer_id: peerId,
      }),
    );
    socket.data.writer.end();
  }

  /** Session open: a known peer plus a fresh ephemeral key from each side. */
  private handleHello(
    socket: Socket<SessionState>,
    clientPubkey: Uint8Array,
    clientEph: Uint8Array | null,
  ): void {
    const match = clientEph === null ? null : this.opts.isKnownPeer(clientPubkey);
    if (match === null || clientEph === null) {
      this.opts.rateLimit.recordFailure(socket.data.peerIp);
      this.writeFrame(socket, JSON.stringify({ kind: "hello_err" }));
      socket.data.writer.end();
      return;
    }
    const serverEph = generateBoxKeypair();
    socket.data.peerPubkey = clientPubkey;
    socket.data.peerMatch = match;
    socket.data.session = {
      key: deriveLanSessionKey({
        ownStatic: this.opts.hostKeypair,
        ownEphemeral: serverEph,
        peerStaticPublic: clientPubkey,
        peerEphemeralPublic: clientEph,
        role: "host",
      }),
      rxSeq: 0,
      txSeq: 0,
    };
    this.writeFrame(
      socket,
      JSON.stringify({
        kind: "hello_ok",
        v: LAN_PROTOCOL_VERSION,
        host_pubkey: Buffer.from(this.opts.hostKeypair.publicKey).toString("base64"),
        server_eph: Buffer.from(serverEph.publicKey).toString("base64"),
      }),
    );
  }

  private async handleEncryptedMessage(
    socket: Socket<SessionState>,
    frame: Uint8Array,
  ): Promise<void> {
    const session = socket.data.session;
    if (!socket.data.peerPubkey || !socket.data.peerMatch || session === undefined) {
      socket.data.writer.end();
      return;
    }
    let plain: Uint8Array;
    try {
      plain = openSessionFrame(session.key, "client_to_host", session.rxSeq, frame);
    } catch {
      socket.data.writer.end();
      return;
    }
    session.rxSeq += 1;
    let msg: { id?: string | number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(plain)) as {
        id?: string | number;
        method?: string;
        params?: unknown;
      };
    } catch {
      socket.data.writer.end();
      return;
    }
    if (typeof msg.method !== "string") {
      socket.data.writer.end();
      return;
    }
    let result: unknown;
    let error: { code: string; message: string } | undefined;
    try {
      checkLanMethodAllowed(msg.method, socket.data.peerMatch);
      result = await this.opts.onMessage(msg.method, msg.params, socket.data.peerMatch);
    } catch (err) {
      if (err instanceof LanError) {
        error = { code: `ERR_${String(err.rpcCode)}`, message: err.message };
      } else {
        const e = err as { code?: string; message?: string };
        error = { code: e.code ?? "ERR_INTERNAL", message: e.message ?? String(err) };
      }
    }
    const response = error ? { id: msg.id, error } : { id: msg.id, result };
    const replyFrame = sealSessionFrame(
      session.key,
      "host_to_client",
      session.txSeq,
      new TextEncoder().encode(JSON.stringify(response)),
    );
    session.txSeq += 1;
    this.writeFrameRaw(socket, replyFrame);
  }

  private writeFrame(socket: Socket<SessionState>, text: string): void {
    this.writeFrameRaw(socket, new TextEncoder().encode(text));
  }

  private writeFrameRaw(socket: Socket<SessionState>, payload: Uint8Array): void {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, payload.length, false);
    socket.data.writer.writeBytes(header);
    socket.data.writer.writeBytes(payload);
  }
}

/** A base64 32-byte public key, or `null` for anything else. */
function decodeKey(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string") return null;
  const key = new Uint8Array(Buffer.from(b64, "base64"));
  return key.length === 32 ? key : null;
}
