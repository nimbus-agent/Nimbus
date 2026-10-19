/**
 * A minimal LAN protocol v2 client for tests that drive `LanServer` at the frame level: build the
 * handshake messages, derive the session key, seal and open session frames with per-direction
 * sequence numbers, and read length-prefixed frames off a real socket.
 *
 * Production code uses `ipc/lan-client.ts`; this exists so a test can do what that client never
 * would (replay a frame, reuse a sequence number, speak v1) and watch the server refuse it.
 */
import type { Socket } from "bun";

import {
  type BoxKeypair,
  deriveLanSessionKey,
  generateBoxKeypair,
  LAN_PROTOCOL_VERSION,
  openSessionFrame,
  pairingProof,
  sealSessionFrame,
} from "../../src/ipc/lan-crypto.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A 4-byte big-endian length prefix followed by the payload. */
export function framed(payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** The JSON a v2 `hello` sends, plus the ephemeral keypair it used. */
export function v2Hello(clientKp: BoxKeypair): { json: string; ephemeral: BoxKeypair } {
  const ephemeral = generateBoxKeypair();
  return {
    json: JSON.stringify({
      kind: "hello",
      v: LAN_PROTOCOL_VERSION,
      client_pubkey: b64(clientKp.publicKey),
      client_eph: b64(ephemeral.publicKey),
    }),
    ephemeral,
  };
}

/** The JSON a v2 `pair` sends: a proof of the code, never the code. */
export function v2PairRequest(clientKp: BoxKeypair, code: string): string {
  return JSON.stringify({
    kind: "pair",
    v: LAN_PROTOCOL_VERSION,
    client_pubkey: b64(clientKp.publicKey),
    proof: b64(pairingProof(code, "client", clientKp.publicKey)),
  });
}

/** One side of an established v2 session, as the client sees it. */
export class V2ClientSession {
  private txSeq = 0;
  private rxSeq = 0;
  constructor(readonly key: Uint8Array) {}

  static fromHelloOk(
    clientKp: BoxKeypair,
    ephemeral: BoxKeypair,
    hostStaticPublic: Uint8Array,
    helloOk: { server_eph?: string },
  ): V2ClientSession {
    return new V2ClientSession(
      deriveLanSessionKey({
        ownStatic: clientKp,
        ownEphemeral: ephemeral,
        peerStaticPublic: hostStaticPublic,
        peerEphemeralPublic: new Uint8Array(Buffer.from(helloOk.server_eph ?? "", "base64")),
        role: "client",
      }),
    );
  }

  /** Seal the next client→host frame. Pass `seq` to reuse or skip a sequence number on purpose. */
  seal(msg: unknown, seq = this.txSeq): Uint8Array {
    const sealed = sealSessionFrame(
      this.key,
      "client_to_host",
      seq,
      enc.encode(JSON.stringify(msg)),
    );
    this.txSeq = seq + 1;
    return sealed;
  }

  open<T = { id?: number; result?: unknown; error?: { code: string; message: string } }>(
    frame: Uint8Array,
  ): T {
    const plain = openSessionFrame(this.key, "host_to_client", this.rxSeq, frame);
    this.rxSeq += 1;
    return JSON.parse(dec.decode(plain)) as T;
  }
}

/** A raw TCP connection to a `LanServer` that collects whole frames and notices the close. */
export interface LanTestConn {
  send(bytes: Uint8Array): void;
  /** The next whole frame, or `null` once the server has closed (or after `timeoutMs`). */
  nextFrame(timeoutMs?: number): Promise<Uint8Array | null>;
  /** The next frame parsed as JSON, or `null`. */
  nextJson<T = Record<string, unknown>>(timeoutMs?: number): Promise<T | null>;
  /** Resolves true once the server closes the connection, false after `timeoutMs`. */
  closed(timeoutMs?: number): Promise<boolean>;
  end(): void;
}

export async function connectLan(port: number): Promise<LanTestConn> {
  let buf = new Uint8Array(0);
  const frames: Uint8Array[] = [];
  const waiters: Array<() => void> = [];
  let isClosed = false;
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const socket: Socket<undefined> = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf, 0);
        merged.set(chunk, buf.length);
        buf = merged;
        while (buf.length >= 4) {
          const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
          if (buf.length < 4 + len) break;
          frames.push(buf.slice(4, 4 + len));
          buf = buf.slice(4 + len);
        }
        wake();
      },
      close() {
        isClosed = true;
        wake();
      },
      error() {
        isClosed = true;
        wake();
      },
    },
  });
  const waitFor = (cond: () => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (cond()) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(cond()), timeoutMs);
      const check = (): void => {
        if (cond()) {
          clearTimeout(timer);
          resolve(true);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  const nextFrame = async (timeoutMs = 2_000): Promise<Uint8Array | null> => {
    await waitFor(() => frames.length > 0 || isClosed, timeoutMs);
    return frames.shift() ?? null;
  };
  return {
    send: (bytes) => {
      socket.write(bytes);
    },
    nextFrame,
    async nextJson<T>(timeoutMs?: number): Promise<T | null> {
      const f = await nextFrame(timeoutMs);
      if (f === null) return null;
      try {
        return JSON.parse(dec.decode(f)) as T;
      } catch {
        return null;
      }
    },
    closed: (timeoutMs = 2_000) => waitFor(() => isClosed, timeoutMs),
    end: () => socket.end(),
  };
}

/**
 * Open a v2 session as `clientKp`: hello, wait for hello_ok, derive the key. Returns `null` (and
 * the reply) when the server refused the hello.
 */
export async function openV2Session(
  port: number,
  clientKp: BoxKeypair,
  hostStaticPublic: Uint8Array,
): Promise<{
  conn: LanTestConn;
  session: V2ClientSession | null;
  reply: Record<string, unknown> | null;
}> {
  const conn = await connectLan(port);
  const { json, ephemeral } = v2Hello(clientKp);
  conn.send(framed(json));
  const reply = await conn.nextJson<Record<string, unknown>>();
  if (reply?.["kind"] !== "hello_ok") return { conn, session: null, reply };
  return {
    conn,
    session: V2ClientSession.fromHelloOk(clientKp, ephemeral, hostStaticPublic, reply),
    reply,
  };
}

/** One RPC over a fresh v2 session; `null` when the server closed without a reply. */
export async function v2Rpc(
  port: number,
  clientKp: BoxKeypair,
  hostStaticPublic: Uint8Array,
  msg: unknown,
): Promise<{ id?: number; result?: unknown; error?: { code: string; message: string } } | null> {
  const { conn, session } = await openV2Session(port, clientKp, hostStaticPublic);
  try {
    if (session === null) return null;
    conn.send(framed(session.seal(msg)));
    const frame = await conn.nextFrame(3_000);
    if (frame === null) return null;
    try {
      return session.open(frame);
    } catch {
      return null;
    }
  } finally {
    conn.end();
  }
}

/** A `PairingService` fake. `code` is the open code; `null` means the window is closed. */
export function fakePairing(code: string | null = null): {
  isOpen: () => boolean;
  consumeMatching: (m: (c: string) => boolean) => string | null;
  open: () => void;
  close: () => void;
  getExpiresAt: () => number | undefined;
} {
  let current = code;
  return {
    isOpen: () => current !== null,
    consumeMatching: (m) => {
      if (current === null || !m(current)) return null;
      const c = current;
      current = null;
      return c;
    },
    open: () => {},
    close: () => {
      current = null;
    },
    getExpiresAt: () => undefined,
  };
}
