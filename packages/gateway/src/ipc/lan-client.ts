import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { sendFederatedLegacy } from "./lan-legacy.ts";
import {
  buildFrame,
  DEFAULT_TIMEOUT_MS,
  flushWriter,
  MAX_HANDSHAKE_FRAME,
  makeFrameReader,
  makeSettler,
  replyKindForMessage,
  writeFrame,
} from "./lan-wire.ts";

export { buildFrame, MAX_HANDSHAKE_FRAME, makeFrameReader, replyKindForMessage, writeFrame };

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
    const finish = makeSettler(
      resolve,
      reject,
      timeoutMs,
      "lan-client: handshake timeout",
      "lan-client: connection closed without reply",
    );
    Bun.connect<undefined>({
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
            finish(undefined, e instanceof Error ? e : new Error(String(e)));
            socket.end();
          }
        },
        drain(socket) {
          flushWriter(socket);
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

/**
 * Temporary alias: the v1 client body now lives in `lan-legacy.ts` as `sendFederatedLegacy` with its
 * original signature. Task 8 replaces this with the negotiating front.
 */
export const sendFederatedOverWire = sendFederatedLegacy;

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
    throw new Error(`lan-client: pairing rejected (${replyKindForMessage(msg.kind)})`);
  }
  const hostPub = new Uint8Array(Buffer.from(msg.host_pubkey, "base64"));
  if (hostPub.length !== 32) throw new Error("lan-client: bad host pubkey length");
  return hostPub;
}
