import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";

const DEFAULT_TIMEOUT_MS = 5000;

interface FrameReader {
  push(chunk: Uint8Array): void;
  next(): Uint8Array | undefined;
}

/** Buffers a 4-byte-length-prefixed stream and yields one frame body at a time. */
export function makeFrameReader(): FrameReader {
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

/** Connect, send one request frame, resolve with the first reply frame body (or reject on timeout/close). */
export function exchangeOneFrame(
  host: string,
  port: number,
  send: (socket: Socket<undefined>) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader();
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
          reader.push(chunk);
          const body = reader.next();
          if (body !== undefined) {
            // Resolve before socket.end() — Bun fires close() synchronously
            // inside socket.end(), so settling first prevents the close handler
            // from winning the race with an "undefined body" rejection.
            finish(body);
            socket.end();
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

/** The production outbound pair handshake (PeerPairing DI default). Returns the responder's box pubkey. */
export async function outboundPairHandshake(
  host: string,
  port: number,
  code: string,
  selfKp: BoxKeypair,
): Promise<Uint8Array> {
  const req = new TextEncoder().encode(
    JSON.stringify({
      kind: "pair",
      client_pubkey: Buffer.from(selfKp.publicKey).toString("base64"),
      pairing_code: code,
    }),
  );
  const body = await exchangeOneFrame(host, port, (s) => writeFrame(s, req));
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
