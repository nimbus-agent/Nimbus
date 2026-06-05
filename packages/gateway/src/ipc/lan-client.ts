import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { openBoxFrame, sealBoxFrame } from "./lan-crypto.ts";
import { MAX_ENCRYPTED_FRAME, MAX_HANDSHAKE_FRAME } from "./lan-server.ts";

export { MAX_HANDSHAKE_FRAME } from "./lan-server.ts";

const DEFAULT_TIMEOUT_MS = 5000;

interface FrameReader {
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

/** Connect, send one request frame, resolve with the first reply frame body (or reject on timeout/close).
 * maxFrameBytes bounds the advertised length before buffering; use MAX_HANDSHAKE_FRAME for pairing,
 * MAX_ENCRYPTED_FRAME for Task 4 encrypted exchanges. */
export function exchangeOneFrame(
  host: string,
  port: number,
  send: (socket: Socket<undefined>) => void,
  maxFrameBytes: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader(maxFrameBytes);
    let settled = false;
    const timer = setTimeout(
      () => finish(undefined, new Error("lan-client: handshake timeout")),
      timeoutMs,
    );
    function finish(body: Uint8Array | undefined, err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (body) resolve(body);
      else reject(new Error("lan-client: connection closed without reply"));
    }
    void Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          try {
            send(socket);
          } catch (e) {
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
          }
        },
        data(socket, chunk) {
          // Consumes a single reply frame (one-shot request/response); callers needing
          // multi-frame exchange must not reuse this as-is.
          reader.push(chunk);
          try {
            const body = reader.next();
            if (body !== undefined) {
              // Resolve before socket.end() — Bun fires close() synchronously
              // inside socket.end(), so settling first prevents the close handler
              // from winning the race with an "undefined body" rejection.
              finish(body);
              socket.end();
            }
          } catch (e) {
            socket.end();
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
          }
        },
        close() {
          finish(undefined);
        },
        error(_s, e) {
          finish(undefined, e instanceof Error ? e : new Error(String(e)));
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))));
  });
}

export function writeFrame(socket: Socket<undefined>, payload: Uint8Array): void {
  socket.write(buildFrame(payload));
}

/** Two-frame exchange: send req frame A (hello), read reply A, send req frame B (from reply A), read reply B. */
function exchangeHelloThenRpc(
  host: string,
  port: number,
  hello: Uint8Array,
  buildRpc: (helloReply: { host_pubkey?: string; kind?: string }) => Uint8Array,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader(MAX_ENCRYPTED_FRAME);
    let phase: "hello" | "rpc" = "hello";
    let settled = false;
    const timer = setTimeout(
      () => finish(undefined, new Error("lan-client: rpc timeout")),
      timeoutMs,
    );
    function finish(body: Uint8Array | undefined, err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (body) resolve(body);
      else reject(new Error("lan-client: connection closed mid-exchange"));
    }
    void Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          writeFrame(socket, hello);
        },
        data(socket, chunk) {
          reader.push(chunk);
          let body: Uint8Array | undefined;
          try {
            body = reader.next();
          } catch (e) {
            socket.end();
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (body === undefined) return;
          if (phase === "hello") {
            let reply: { host_pubkey?: string; kind?: string };
            try {
              reply = JSON.parse(new TextDecoder().decode(body)) as typeof reply;
            } catch {
              socket.end();
              finish(undefined, new Error("lan-client: bad hello reply"));
              return;
            }
            if (reply.kind !== "hello_ok") {
              socket.end();
              finish(
                undefined,
                new Error(`lan-client: hello rejected (${reply.kind ?? "unknown"})`),
              );
              return;
            }
            phase = "rpc";
            try {
              writeFrame(socket, buildRpc(reply));
            } catch (e) {
              socket.end();
              finish(undefined, e instanceof Error ? e : new Error(String(e)));
            }
            return;
          }
          // phase === "rpc": resolve before socket.end() — Bun fires close() synchronously
          // inside socket.end(), so settling first prevents the close handler
          // from winning the race with an "undefined body" rejection.
          finish(body);
          socket.end();
        },
        close() {
          finish(undefined);
        },
        error(_s, e) {
          finish(undefined, e instanceof Error ? e : new Error(String(e)));
        },
      },
    }).catch((e: unknown) => finish(undefined, e instanceof Error ? e : new Error(String(e))));
  });
}

/** Send one authenticated, encrypted federation RPC to a paired peer and return its result. */
export async function sendFederatedOverWire(
  host: string,
  port: number,
  selfKp: BoxKeypair,
  peerPubkey: Uint8Array,
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const hello = new TextEncoder().encode(
    JSON.stringify({
      kind: "hello",
      client_pubkey: Buffer.from(selfKp.publicKey).toString("base64"),
    }),
  );
  const replyFrame = await exchangeHelloThenRpc(
    host,
    port,
    hello,
    (reply) => {
      const hostPub = new Uint8Array(Buffer.from(reply.host_pubkey ?? "", "base64"));
      if (Buffer.compare(Buffer.from(hostPub), Buffer.from(peerPubkey)) !== 0) {
        throw new Error("lan-client: responder pubkey does not match pinned peer key");
      }
      return sealBoxFrame(
        new TextEncoder().encode(JSON.stringify({ id: 1, method, params })),
        peerPubkey,
        selfKp.secretKey,
      );
    },
    timeoutMs,
  );
  const plain = openBoxFrame(replyFrame, peerPubkey, selfKp.secretKey);
  const resp = JSON.parse(new TextDecoder().decode(plain)) as {
    result?: unknown;
    error?: { code?: string; message?: string };
  };
  if (resp.error !== undefined) {
    throw new Error(
      `lan-client: peer error ${resp.error.code ?? ""} ${resp.error.message ?? ""}`.trim(),
    );
  }
  return resp.result;
}

/** The production outbound pair handshake (PeerPairing DI default). Returns the responder's box pubkey. */
export async function outboundPairHandshake(
  host: string,
  port: number,
  code: string,
  selfKp: BoxKeypair,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  const req = new TextEncoder().encode(
    JSON.stringify({
      kind: "pair",
      client_pubkey: Buffer.from(selfKp.publicKey).toString("base64"),
      pairing_code: code,
    }),
  );
  const body = await exchangeOneFrame(
    host,
    port,
    (s) => writeFrame(s, req),
    MAX_HANDSHAKE_FRAME,
    timeoutMs,
  );
  const msg = JSON.parse(new TextDecoder().decode(body)) as {
    kind?: string;
    host_pubkey?: string;
  };
  if (msg.kind !== "pair_ok" || typeof msg.host_pubkey !== "string") {
    throw new Error(`lan-client: pairing rejected (${msg.kind ?? "unknown"})`);
  }
  const hostPub = new Uint8Array(Buffer.from(msg.host_pubkey, "base64"));
  if (hostPub.length !== 32) throw new Error("lan-client: bad host pubkey length");
  return hostPub;
}
