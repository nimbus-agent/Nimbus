import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { createInitiatorHandshake, MAX_RECORD_FRAME } from "./lan-session.ts";
import { DEFAULT_TIMEOUT_MS, flushWriter, makeFrameReader, writeFrame } from "./lan-wire.ts";

/** The production outbound pair handshake (PeerPairing DI default): Noise XXpsk0, FS2. */
export { outboundPairHandshake } from "./lan-pair-client.ts";
export { buildFrame, MAX_HANDSHAKE_FRAME } from "./lan-wire.ts";
export { makeFrameReader, writeFrame };

/**
 * The link policy for one peer (LAN forward secrecy, invariant I56). Built by
 * `federation/lan-link.ts` from the peer row; REQUIRED on every call so a caller cannot forget the
 * ratchet write.
 */
export interface LanLink {
  /** What this peer has completed with us (`lan_peers.proto_version`): 1 until its first v2 session. */
  known: 1 | 2;
  /** Called once, when a v2 handshake completes with a peer that was still recorded at 1. */
  onNegotiated?: ((version: 2) => void) | undefined;
}

/** The text a stale pin or a re-installed peer produces (spec section 9: message 1 fails silently). */
export const NO_REPLY_HINT =
  "lan-client: no reply: the peer may have been re-paired or reset (run `nimbus team pair` again), or it runs a version from before LAN forward secrecy, whose old wire this version no longer speaks (upgrade that peer to the same release or newer)";

/**
 * One v2 exchange: Noise IK handshake, then the request as records, then records until the reply
 * message is whole. Resolves with the reply message bytes. Only a failure BEFORE message 2 arrives
 * gets the no-reply hint (an old server, a stale pin, or a reset or lost peer).
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
    let conn: Socket<undefined> | undefined;
    const finish = (body: Uint8Array | undefined, err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Every terminal outcome closes the socket, so a peer that never answers cannot hold it open.
      conn?.end();
      if (err) reject(err);
      else resolve(body as Uint8Array);
    };
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          session === undefined
            ? new Error(
                "lan-client: handshake timeout (no reply from the peer; if it runs a version from before LAN forward secrecy, upgrade it)",
              )
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
          conn = socket;
          // A connection that opens after the call already settled (a timeout) is closed unused.
          if (settled) {
            socket.end();
            return;
          }
          writeFrame(socket, handshake.firstFrameBody);
        },
        data(socket, chunk) {
          if (settled) return;
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
              ? new Error(NO_REPLY_HINT)
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
 * Send one authenticated federation RPC to a paired peer and return its result. Every call is a
 * v2 (Noise IK) session; no other wire exists (FS3), so a peer on a version from before LAN forward
 * secrecy gets no answer to message 1 and the call fails with `NO_REPLY_HINT` or the handshake-timeout
 * text, both of which tell the owner to upgrade it.
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
  const reply = await exchangeV2(host, port, selfKp, peerPubkey, request, timeoutMs, () => {
    if (link.known === 1) link.onNegotiated?.(2);
  });
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
