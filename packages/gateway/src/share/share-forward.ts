// packages/gateway/src/share/share-forward.ts
import type { ShareFile } from "./share-format.ts";
import { verifyShareBytes } from "./share-format.ts";
import { appendForwardingHop } from "./share-forwarding.ts";

export interface ForwardPeer {
  readonly host: string;
  readonly port: number;
  readonly pubkey: string;
}

export interface ForwardShareDeps {
  readonly now: () => number;
  readonly label: string;
  readonly loadShare: (contentHash: string) => ShareFile | undefined;
  readonly shareKeypair: () => Promise<{ privkeyB64: string; pubkeyB64: string }>;
  readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;
  readonly lookupPeer: (recipientPubkey: string) => ForwardPeer | undefined;
  readonly deliver: (share: ShareFile, peer: ForwardPeer) => Promise<void>;
  readonly queuePending: (recipientPubkey: string, share: ShareFile) => void;
  readonly recordAudit: (e: {
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
  }) => void;
}

export type ForwardOutcome =
  | { readonly status: "rejected" }
  | { readonly status: "ok"; readonly delivered: boolean; readonly contentHash: string };

/**
 * Re-forward an existing signed share to a peer — the SECOND I27 outbound-share chokepoint
 * (the first is `createShare`). The inner body+sig are never altered; only a forwarding hop is
 * appended (unless this gateway IS the origin). Owner-HITL via `share.publish` is mandatory and
 * fail-closed (a deny forwards/queues NOTHING). A reachable paired peer is delivered to immediately;
 * a not-yet-paired recipient is queued in `share_inbox` (drained on first pair, spec §9.4).
 */
export async function forwardShare(
  req: { contentHash: string; recipientPubkey: string },
  deps: ForwardShareDeps,
): Promise<ForwardOutcome> {
  const share = deps.loadShare(req.contentHash);
  if (share === undefined) return { status: "rejected" };

  const preview = {
    contentHash: share.contentHash,
    origin: share.body.origin,
    hops: share.forwarding.hops,
    recipientPubkey: req.recipientPubkey,
  };
  const approved = await deps.requestApproval(preview, share.body.redactionSet);
  const ts = deps.now();
  if (!approved) {
    deps.recordAudit({
      actionType: "share.publish",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({ forward: preview }),
      timestamp: ts,
    });
    return { status: "rejected" };
  }

  // Append THIS gateway's hop unless it authored the share (origin == self → no self-hop).
  const kp = await deps.shareKeypair();
  const forwarded =
    share.body.origin.pubkey === kp.pubkeyB64
      ? share
      : appendForwardingHop(share, {
          gatewayLabel: deps.label,
          pubkeyB64: kp.pubkeyB64,
          privkeyB64: kp.privkeyB64,
        });

  const peer = deps.lookupPeer(req.recipientPubkey);
  let delivered = false;
  if (peer === undefined) {
    deps.queuePending(req.recipientPubkey, forwarded);
  } else {
    await deps.deliver(forwarded, peer);
    delivered = true;
  }

  deps.recordAudit({
    actionType: "share.publish",
    hitlStatus: "approved",
    actionJson: JSON.stringify({
      forward: preview,
      delivered,
      hops: forwarded.forwarding.hops,
    }),
    timestamp: ts,
  });
  return { status: "ok", delivered, contentHash: share.contentHash };
}

export interface ReceiveShareDeps {
  readonly now: () => number;
  /** Persist the inbound share as an INERT, viewable artifact (insertReceivedShare). */
  readonly storeReceived: (share: ShareFile) => void;
}

export type ReceiveOutcome = { readonly ok: boolean; readonly reason?: string };

/**
 * Accept an inbound forwarded share and store it INERT (spec §9.4): the content signature must
 * verify (reject otherwise — never persist a forged body), then the share is recorded as a
 * viewable/replayable artifact. This function has NO access to the executor, index writer, or
 * embedding pipeline — receiving never executes, never merges into the index, and needs no HITL.
 * The advisory hop chain is not a storage gate.
 */
export async function receiveForwardedShare(
  rawShare: unknown,
  deps: ReceiveShareDeps,
): Promise<ReceiveOutcome> {
  if (rawShare === null || typeof rawShare !== "object") {
    return { ok: false, reason: "malformed" };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(rawShare));
  const verdict = verifyShareBytes(bytes, { now: deps.now() });
  if (!verdict.signatureValid || !verdict.contentHashValid) {
    return { ok: false, reason: "content signature invalid" };
  }
  deps.storeReceived(rawShare as ShareFile);
  return { ok: true };
}
