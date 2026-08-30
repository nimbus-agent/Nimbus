import { randomUUID } from "node:crypto";
import type { RemoteApprovalOutcome } from "../engine/delegated-approval.ts";
import { getChatopsApprovalContext } from "./chatops-request-context.ts";

export interface ApprovalPresenterDeps {
  /** Post the approval card to a channel (the owner's DM/channel). */
  readonly post: (channelId: string, text: string) => Promise<void>;
  /** Resolve an owner email → the channel where their approvals are surfaced. */
  readonly ownerChannelFor: (email: string) => string | undefined;
}

interface PendingApproval {
  readonly ownerExternalId: string;
  readonly resolve: (o: RemoteApprovalOutcome) => void;
}

export interface ApprovalClick {
  readonly requestId: string;
  readonly approverExternalId: string;
  readonly approved: boolean;
}

/**
 * Renders an owner-routed Approve/Reject card and resolves the executor's `requestRemote` with the
 * clicker identity. The executor's I20 path then verifies the clicker is a live, in-scope,
 * identity-valid delegate (here: the resolved resource owner) before honoring the decision.
 */
export class ApprovalPresenter {
  private readonly pending = new Map<string, PendingApproval>();
  private last = "";
  constructor(private readonly deps: ApprovalPresenterDeps) {}

  lastRequestId(): string {
    return this.last;
  }

  /** Wired as the executor's `requestRemote`. Reads the owner context from AsyncLocalStorage. */
  async requestApproval(): Promise<RemoteApprovalOutcome> {
    const ctx = getChatopsApprovalContext();
    if (ctx === undefined) return { kind: "timeout" };
    const channel = this.deps.ownerChannelFor(ctx.ownerEmail);
    if (channel === undefined) return { kind: "timeout" }; // → executor falls back to local owner
    const requestId = randomUUID();
    this.last = requestId;
    // Register the resolver synchronously (the Promise executor runs before the first await) so a
    // click that arrives before `post` resolves still finds the pending entry — no resolve race.
    const outcome = new Promise<RemoteApprovalOutcome>((resolve) => {
      this.pending.set(requestId, { ownerExternalId: ctx.ownerExternalId, resolve });
    });
    try {
      await this.deps.post(
        channel,
        `Approval needed from ${ctx.ownerEmail}: ${ctx.actionLabel} (requested by ${ctx.requesterExternalId}). Reply Approve/Reject.`,
      );
    } catch (err) {
      // The card was never shown to the owner (post failed, e.g. the I29 append-before-post
      // egress ledger rejected it) — this pending entry must not survive the failure, or a
      // later `resolveClick` on a stale/reused request id could still resolve `outcome`.
      this.pending.delete(requestId);
      throw err;
    }
    return await outcome;
  }

  /** Called by the transport adapter when the owner clicks. */
  resolveClick(click: ApprovalClick): boolean {
    const entry = this.pending.get(click.requestId);
    if (entry === undefined) return false;
    this.pending.delete(click.requestId);
    entry.resolve({ kind: "answered", peerId: click.approverExternalId, approved: click.approved });
    return true;
  }
}
