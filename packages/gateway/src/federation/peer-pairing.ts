import { bytesToHex } from "@noble/hashes/utils.js";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";

export interface InboundPairRequest {
  readonly peerPubkey: Uint8Array;
  readonly hostIp?: string; // optional — matches hostPort?/displayName? and addLanPeer
  readonly hostPort?: number;
  readonly displayName?: string;
}

/**
 * Performs the outbound LAN pair handshake against a responder and returns the responder's box
 * public key on accept. Injected (DI) so `initiatePair` is unit-testable with a fake, and the
 * real socket body is implemented once against the wire protocol proven in
 * `ipc/lan-server-handshake.test.ts`. (See plan's deferred-seams list — no production outbound
 * LAN client exists yet; this is the one genuinely net-new seam, deferred behind DI.)
 */
export type OutboundPairHandshake = (
  host: string,
  port: number,
  code: string,
) => Promise<Uint8Array>;

/** Deterministic peer id from the pubkey (first 16 hex of the key). */
function peerIdFor(pubkey: Uint8Array): string {
  return `peer:${bytesToHex(pubkey.subarray(0, 8))}`;
}

/**
 * Mutual peer pairing. An inbound request is staged (`beginInboundPair`) and persisted ONLY
 * after the owner approves (`approveInboundPair`). Federation peers are always read-only
 * (`write_allowed = 0`, enforced by LocalIndex.addLanPeer) — Slice 1 answering never needs write.
 */
export class PeerPairing {
  constructor(
    private readonly index: LocalIndex,
    /** Outbound handshake. Defaults to the real LAN-client implementation in production;
     *  injected with a fake in unit tests. The default is wired in Task 15's E2E. */
    private readonly handshake?: OutboundPairHandshake,
    /** Fired once with the new peerId after a peer is first persisted — drives the
     *  share-inbox drain (8d). Best-effort: a drain failure must never fail the pairing. */
    private readonly onPairComplete?: (peerId: string) => void | Promise<void>,
  ) {}

  /**
   * Outbound (initiator) pairing: connect to a discovered peer, run the pair handshake, and on
   * accept persist the peer row as direction 'outbound' (read-only). Returns the new peerId.
   * Throws if no handshake implementation is wired.
   */
  async initiatePair(host: string, port: number, code: string): Promise<string> {
    if (this.handshake === undefined) {
      throw new Error("federation: outbound pair handshake not wired");
    }
    const peerPubkey = await this.handshake(host, port, code);
    const peerId = peerIdFor(peerPubkey);
    this.index.addLanPeer({
      peerId,
      peerPubkey,
      direction: "outbound",
      hostIp: host,
      hostPort: port,
    });
    // Fire-and-forget the best-effort drain (same guard as approveInboundPair): the hook does
    // network delivery work, so AWAITING it would let a slow/hung drain stall successful pairing.
    if (this.onPairComplete) {
      try {
        const res = this.onPairComplete(peerId);
        if (res instanceof Promise) res.catch(() => {}); // swallow async rejection (best-effort)
      } catch {
        /* swallow sync throw — pairing must succeed even if the drain fails */
      }
    }
    return peerId;
  }

  beginInboundPair(req: InboundPairRequest): InboundPairRequest {
    // Staging is intentionally a no-op holder; approval is the structural gate.
    return req;
  }

  approveInboundPair(req: InboundPairRequest): string {
    const peerId = peerIdFor(req.peerPubkey);
    this.index.addLanPeer({
      peerId,
      peerPubkey: req.peerPubkey,
      direction: "inbound",
      ...(req.hostIp === undefined ? {} : { hostIp: req.hostIp }),
      ...(req.hostPort === undefined ? {} : { hostPort: req.hostPort }),
      ...(req.displayName === undefined ? {} : { displayName: req.displayName }),
    });
    if (this.onPairComplete) {
      try {
        const res = this.onPairComplete(peerId);
        if (res instanceof Promise) res.catch(() => {}); // swallow async rejection (best-effort drain)
      } catch {
        /* swallow sync throw — pairing must succeed even if the drain fails */
      }
    }
    return peerId;
  }

  rejectInboundPair(_req: InboundPairRequest): void {
    // Explicit rejection: nothing persisted. Present for symmetry + audit hooks.
  }

  listPeers(): LanPeerRow[] {
    return this.index.listLanPeers();
  }

  removePeer(peerId: string): void {
    this.index.removeLanPeer(peerId);
  }
}
