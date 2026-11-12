import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { sendFederatedLegacy } from "./lan-legacy.ts";
import { createInitiatorHandshake, MAX_RECORD_FRAME } from "./lan-session.ts";
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
 * The link policy for one peer (LAN forward secrecy, invariant I56). Built by
 * `federation/lan-link.ts` from the peer row and `[lan] min_protocol`; REQUIRED on every call so a
 * caller cannot forget the ratchet.
 */
export interface LanLink {
  /** What this peer has completed with us (`lan_peers.proto_version`): 2 means never talk v1 again. */
  known: 1 | 2;
  /** `[lan] min_protocol`: 2 forbids the old wire altogether. */
  minProtocol: 1 | 2;
  /** Called once, when a v2 handshake completes with a peer that was still recorded at 1. */
  onNegotiated?: ((version: 2) => void) | undefined;
}

/** The v2 attempt got no answer to message 1: an old server, a stale pin, or a reset/lost peer. */
class HandshakeUnansweredError extends Error {}

/** The text a stale pin or a re-installed peer produces (spec section 9: message 1 fails silently). */
export const NO_REPLY_HINT =
  "lan-client: no reply: the peer may have been re-paired or reset; run `nimbus team pair` again";

/**
 * One v2 exchange: Noise IK handshake, then the request as records, then records until the reply
 * message is whole. Resolves with the reply message bytes. Only a failure BEFORE message 2 arrives
 * is a `HandshakeUnansweredError` (the only kind that may fall back to v1).
 */
function exchangeV2(
  host: string,
  port: number,
  selfKp: BoxKeypair,
  peerPubkey: Uint8Array,
  request: Uint8Array,
  timeoutMs: number,
  onHandshake: () => void,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const handshake = createInitiatorHandshake({ s: selfKp, rs: peerPubkey });
    const reader = makeFrameReader(MAX_RECORD_FRAME);
    let session: ReturnType<typeof handshake.finish> | undefined;
    let settled = false;
    const finish = (body: Uint8Array | undefined, err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(body as Uint8Array);
    };
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          session === undefined
            ? new HandshakeUnansweredError("lan-client: handshake timeout")
            : new Error("lan-client: rpc timeout"),
        ),
      timeoutMs,
    );
    const step = (socket: Socket<undefined>, frame: Uint8Array): boolean => {
      if (session === undefined) {
        session = handshake.finish(frame);
        onHandshake();
        for (const record of session.sealMessage(request)) writeFrame(socket, record);
        return false;
      }
      const message = session.openRecord(frame);
      if (message === undefined) return false;
      // Resolve before socket.end(): Bun fires close() synchronously inside end().
      finish(message);
      socket.end();
      return true;
    };
    Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          writeFrame(socket, handshake.firstFrameBody);
        },
        data(socket, chunk) {
          reader.push(chunk);
          try {
            for (let frame = reader.next(); frame !== undefined; frame = reader.next()) {
              if (step(socket, frame)) return;
            }
          } catch (e) {
            finish(undefined, e as Error);
            socket.end();
          }
        },
        drain(socket) {
          flushWriter(socket);
        },
        close() {
          finish(
            undefined,
            session === undefined
              ? new HandshakeUnansweredError(NO_REPLY_HINT)
              : new Error("lan-client: connection closed mid-exchange"),
          );
        },
        error(_s, e) {
          finish(undefined, e);
        },
      },
    }).catch((e: unknown) => finish(undefined, e as Error));
  });
}

/**
 * Send one authenticated federation RPC to a paired peer and return its result. Prefers a v2
 * (Noise IK) session; a peer recorded at protocol 2, or any peer under `min_protocol = 2`, is never
 * talked to over the v1 box wire. For a peer still recorded at 1, a v2 attempt that gets NO answer
 * to message 1 (an old server) is retried once in v1 (the compatibility window, OR-FS-1); a bad
 * record or any later failure never falls back.
 */
export async function sendFederatedOverWire(
  host: string,
  port: number,
  selfKp: BoxKeypair,
  peerPubkey: Uint8Array,
  method: string,
  params: unknown,
  timeoutMs: number | undefined = DEFAULT_TIMEOUT_MS,
  link: LanLink,
): Promise<unknown> {
  const request = new TextEncoder().encode(JSON.stringify({ id: 1, method, params }));
  let reply: Uint8Array;
  try {
    reply = await exchangeV2(host, port, selfKp, peerPubkey, request, timeoutMs, () => {
      if (link.known === 1) link.onNegotiated?.(2);
    });
  } catch (err) {
    if (!(err instanceof HandshakeUnansweredError) || link.known === 2 || link.minProtocol === 2) {
      throw err;
    }
    return sendFederatedLegacy(host, port, selfKp, peerPubkey, method, params, timeoutMs);
  }
  const resp = JSON.parse(new TextDecoder().decode(reply)) as {
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
    throw new Error(`lan-client: pairing rejected (${replyKindForMessage(msg.kind)})`);
  }
  const hostPub = new Uint8Array(Buffer.from(msg.host_pubkey, "base64"));
  if (hostPub.length !== 32) throw new Error("lan-client: bad host pubkey length");
  return hostPub;
}
