import type { Socket, TCPSocketListener } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { openBoxFrame, sealBoxFrame } from "./lan-crypto.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

export const MAX_HANDSHAKE_FRAME = 4_096;
export const MAX_ENCRYPTED_FRAME = 4 * 1024 * 1024;
export const MAX_PENDING_BYTES = MAX_ENCRYPTED_FRAME + 65_536;

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

interface SessionState {
  peerPubkey?: Uint8Array;
  peerMatch?: LanPeerMatch;
  peerIp: string;
  buffer: Uint8Array;
}

export class LanServer {
  private instance: TCPSocketListener<SessionState> | undefined;

  constructor(private readonly opts: LanServerOptions) {}

  async start(): Promise<void> {
    this.instance = Bun.listen<SessionState>({
      hostname: this.opts.bind,
      port: this.opts.port,
      socket: {
        open: (socket) => {
          socket.data = {
            peerIp: socket.remoteAddress,
            buffer: new Uint8Array(0),
          };
        },
        data: (socket, chunk) => {
          void this.handleChunk(socket, chunk);
        },
        close: () => {},
        error: () => {},
      },
    });
  }

  async stop(): Promise<void> {
    this.instance?.stop(true);
    this.instance = undefined;
  }

  listenAddr(): { host: string; port: number } | undefined {
    if (!this.instance) return undefined;
    return { host: this.opts.bind, port: this.instance.port };
  }

  private async handleChunk(socket: Socket<SessionState>, chunk: Uint8Array): Promise<void> {
    const prev = socket.data.buffer;
    if (prev.length + chunk.length > MAX_PENDING_BYTES) {
      socket.end();
      return;
    }
    const merged = new Uint8Array(prev.length + chunk.length);
    merged.set(prev, 0);
    merged.set(chunk, prev.length);
    socket.data.buffer = merged;

    while (socket.data.buffer.length >= 4) {
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
        socket.end();
        return;
      }
      if (socket.data.buffer.length < 4 + length) return;
      const payload = socket.data.buffer.slice(4, 4 + length);
      socket.data.buffer = socket.data.buffer.slice(4 + length);

      if (socket.data.peerPubkey) {
        await this.handleEncryptedMessage(socket, payload);
      } else {
        await this.handleHandshake(socket, payload);
      }
    }
  }

  private async handleHandshake(socket: Socket<SessionState>, payload: Uint8Array): Promise<void> {
    let msg: { kind?: string; client_pubkey?: string; pairing_code?: string };
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as {
        kind?: string;
        client_pubkey?: string;
        pairing_code?: string;
      };
    } catch {
      socket.end();
      return;
    }
    if (msg.kind !== "pair" && msg.kind !== "hello") {
      socket.end();
      return;
    }
    if (typeof msg.client_pubkey !== "string") {
      socket.end();
      return;
    }
    const clientPubkey = new Uint8Array(Buffer.from(msg.client_pubkey, "base64"));
    if (clientPubkey.length !== 32) {
      socket.end();
      return;
    }

    const ip = socket.data.peerIp;
    if (!this.opts.rateLimit.checkAllowed(ip)) {
      this.writeFrame(
        socket,
        JSON.stringify({ kind: msg.kind === "hello" ? "hello_err" : "pair_err" }),
      );
      socket.end();
      return;
    }

    if (msg.kind === "pair") {
      if (typeof msg.pairing_code !== "string" || !this.opts.pairing.isOpen()) {
        this.opts.rateLimit.recordFailure(ip);
        this.writeFrame(socket, JSON.stringify({ kind: "pair_err" }));
        socket.end();
        return;
      }
      const ok = this.opts.pairing.consume(msg.pairing_code);
      if (!ok) {
        this.opts.rateLimit.recordFailure(ip);
        this.writeFrame(socket, JSON.stringify({ kind: "pair_err" }));
        socket.end();
        return;
      }
      const peerId = this.opts.registerPeer(clientPubkey, ip);
      socket.data.peerPubkey = clientPubkey;
      socket.data.peerMatch = { peerId, writeAllowed: false };
      this.opts.rateLimit.recordSuccess(ip);
      this.writeFrame(
        socket,
        JSON.stringify({
          kind: "pair_ok",
          host_pubkey: Buffer.from(this.opts.hostKeypair.publicKey).toString("base64"),
          peer_id: peerId,
        }),
      );
      return;
    }

    const match = this.opts.isKnownPeer(clientPubkey);
    if (!match) {
      this.opts.rateLimit.recordFailure(ip);
      this.writeFrame(socket, JSON.stringify({ kind: "hello_err" }));
      socket.end();
      return;
    }
    socket.data.peerPubkey = clientPubkey;
    socket.data.peerMatch = match;
    this.writeFrame(
      socket,
      JSON.stringify({
        kind: "hello_ok",
        host_pubkey: Buffer.from(this.opts.hostKeypair.publicKey).toString("base64"),
      }),
    );
  }

  private async handleEncryptedMessage(
    socket: Socket<SessionState>,
    frame: Uint8Array,
  ): Promise<void> {
    if (!socket.data.peerPubkey || !socket.data.peerMatch) {
      socket.end();
      return;
    }
    let plain: Uint8Array;
    try {
      plain = openBoxFrame(frame, socket.data.peerPubkey, this.opts.hostKeypair.secretKey);
    } catch {
      socket.end();
      return;
    }
    let msg: { id?: string | number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(plain)) as {
        id?: string | number;
        method?: string;
        params?: unknown;
      };
    } catch {
      socket.end();
      return;
    }
    if (typeof msg.method !== "string") {
      socket.end();
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
    const replyFrame = sealBoxFrame(
      new TextEncoder().encode(JSON.stringify(response)),
      socket.data.peerPubkey,
      this.opts.hostKeypair.secretKey,
    );
    this.writeFrameRaw(socket, replyFrame);
  }

  private writeFrame(socket: Socket<SessionState>, text: string): void {
    this.writeFrameRaw(socket, new TextEncoder().encode(text));
  }

  private writeFrameRaw(socket: Socket<SessionState>, payload: Uint8Array): void {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, payload.length, false);
    socket.write(header);
    socket.write(payload);
  }
}
