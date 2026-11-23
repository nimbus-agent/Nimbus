/**
 * The responder half of a v2 pairing (invariant I56, Phase 10 FS2): the ordered steps a `LanServer`
 * runs for a first frame whose pattern byte says `XXpsk0`. The order is the security argument, so it
 * is written as visible steps, as `LanServer.handleV2Handshake` does for IK:
 *
 *  1. the rate limiter, before any DH: a locked-out address gets no bytes back;
 *  2. a window must be open: without one there is no PSK, nothing is computed, the IP is charged;
 *  3. message 1 must open under the window's PSK: a wrong code closes with NO reply and ONE counted
 *     failure, at once, and the window stays open (a wrong guess does not burn the owner's code);
 *  4. message 2 goes out; the session now waits for message 3;
 *  5. message 3 must open; only then does `consumeOpen()` close the window (of two initiators with
 *     the right code, the second is refused), the initiator is registered at protocol 2, and the
 *     first transport record `{kind:"pair_ok", peer_id}` is sent.
 *
 * The code is never compared here (an AEAD tag is the check), and never consumed by a failed step.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import { openPairResponder, type PairResponder } from "./lan-pair-session.ts";
import type { PairingService, RateLimiterService } from "./lan-wire.ts";
import { writeFramedBytes } from "./lan-wire.ts";
import type { QueuedSocketWriter } from "./server/queued-socket-writer.ts";

/** The slice of a connection's state the pairing steps read and write. */
export interface PairHost {
  peerIp: string;
  writer: QueuedSocketWriter;
  /** Set after message 2 was sent; the connection then expects message 3. */
  pair?: PairResponder | undefined;
}

export interface PairServerContext {
  hostKeypair: BoxKeypair;
  rateLimit: RateLimiterService;
  pairing: PairingService;
  /** Persists the initiator (D-FS-17: at protocol 2) and returns its peer id. */
  registerPeer: (pubkey: Uint8Array, peerIp: string, protoVersion?: 1 | 2) => string;
}

function refuse(host: PairHost, ctx: PairServerContext): "closed" {
  ctx.rateLimit.recordFailure(host.peerIp);
  host.writer.end();
  return "closed";
}

/** Steps 1 to 4. `closed` means the socket was ended; `continue` means message 3 is awaited. */
export function pairHandleFirstFrame(
  host: PairHost,
  ctx: PairServerContext,
  firstFrameBody: Uint8Array,
): "closed" | "continue" {
  if (!ctx.rateLimit.checkAllowed(host.peerIp)) {
    host.writer.end();
    return "closed";
  }
  const psk = ctx.pairing.currentPsk();
  if (psk === undefined) return refuse(host, ctx);
  let responder: PairResponder;
  try {
    responder = openPairResponder(firstFrameBody, { s: ctx.hostKeypair, psk });
  } catch {
    return refuse(host, ctx);
  } finally {
    psk.fill(0);
  }
  writeFramedBytes(host.writer, responder.message2);
  host.pair = responder;
  return "continue";
}

/** Step 5. Always ends the socket (a pairing connection carries no requests). */
export function pairHandleMessage3(
  host: PairHost,
  ctx: PairServerContext,
  message3: Uint8Array,
): void {
  const responder = host.pair;
  host.pair = undefined;
  if (responder === undefined) {
    host.writer.end();
    return;
  }
  let finished: ReturnType<PairResponder["finish"]>;
  try {
    finished = responder.finish(message3);
  } catch {
    refuse(host, ctx);
    return;
  }
  if (!ctx.pairing.consumeOpen()) {
    refuse(host, ctx);
    return;
  }
  let peerId: string;
  try {
    peerId = ctx.registerPeer(finished.remoteStatic, host.peerIp, 2);
  } catch {
    host.writer.end();
    return;
  }
  ctx.rateLimit.recordSuccess(host.peerIp);
  const reply = new TextEncoder().encode(JSON.stringify({ kind: "pair_ok", peer_id: peerId }));
  for (const record of finished.session.sealMessage(reply)) writeFramedBytes(host.writer, record);
  host.writer.end();
}
