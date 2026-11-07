import { randomUUID } from "node:crypto";
import type { RemoteApprovalOutcome } from "../engine/delegated-approval.ts";
import { getChatopsApprovalContext } from "./chatops-request-context.ts";
import {
  CONFIRM_TYPED_MAX,
  clipLabel,
  confirmCardFor,
  confirmFallbackLine,
} from "./confirm-card.ts";
import type { ChatCard, ChatPlatform } from "./types.ts";

export interface ApprovalPresenterDeps {
  /** Post the approval card to a channel (the owner's DM/channel). */
  readonly post: (channelId: string, text: string, card?: ChatCard) => Promise<void>;
  /** Resolve an owner email → the channel where their approvals are surfaced. */
  readonly ownerChannelFor: (email: string) => string | undefined;
  /**
   * The platform a channel speaks (it is not on the AsyncLocalStorage context), so a confirm card
   * is built for the right one. Absent or unknown: `slack`, as `post` defaults.
   */
  readonly platformFor?: (channelId: string) => ChatPlatform | undefined;
}

interface PlainPending {
  readonly kind: "plain";
  readonly ownerExternalId: string;
  readonly resolve: (o: RemoteApprovalOutcome) => void;
}

interface ConfirmPending {
  readonly kind: "confirm";
  readonly ownerExternalId: string;
  readonly channelId: string;
  readonly label: string;
  readonly confirmText: string;
  readonly resolve: (o: RemoteApprovalOutcome) => void;
}

type PendingApproval = PlainPending | ConfirmPending;

export interface ApprovalClick {
  readonly requestId: string;
  readonly approverExternalId: string;
  readonly approved: boolean;
}

/** What a Slack Confirm click needs to open the modal: returned to the card's owner only. */
export interface ConfirmOpenDetails {
  readonly channelId: string;
  readonly label: string;
  readonly confirmText: string;
}

export interface ConfirmSubmit {
  readonly requestId: string;
  readonly approverExternalId: string;
  readonly approved: boolean;
  /** Whatever the form delivered. Never compared here (static D41): it is handed to the executor. */
  readonly typed: unknown;
}

/**
 * Renders an owner-routed Approve/Reject card and resolves the executor's `requestRemote` with the
 * clicker identity. The executor's I20 path then verifies the clicker is a live, in-scope,
 * identity-valid delegate (here: the resolved resource owner) before honoring the decision.
 *
 * A type-to-confirm card (`requestTypedApproval`, Phase 9.7 D0c) is a different pending kind: it
 * resolves only from the owner, through a form that delivers the typed text unformatted, and a
 * channel text `approve` never resolves it.
 */
export class ApprovalPresenter {
  private readonly pending = new Map<string, PendingApproval>();
  private last = "";
  constructor(private readonly deps: ApprovalPresenterDeps) {}

  lastRequestId(): string {
    return this.last;
  }

  /** The kind of a live card, or undefined when the request is unknown or already spent. */
  pendingKind(requestId: string): "plain" | "confirm" | undefined {
    return this.pending.get(requestId)?.kind;
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
      this.pending.set(requestId, {
        kind: "plain",
        ownerExternalId: ctx.ownerExternalId,
        resolve,
      });
    });
    await this.postOrDrop(
      requestId,
      channel,
      `Approval needed from ${ctx.ownerEmail}: ${ctx.actionLabel} (requested by ${ctx.requesterExternalId}). Reply Approve/Reject.`,
    );
    return await outcome;
  }

  /**
   * Wired as the executor's `requestRemoteConfirmed` (one argument: the platform and owner come from
   * the request context). Posts a card with a form that collects the typed text. A confirm text over
   * the form's cap cannot be shown whole, so no card is posted and the request times out (not
   * delegated; the executor's fallback applies).
   */
  async requestTypedApproval(confirmText: string): Promise<RemoteApprovalOutcome> {
    const ctx = getChatopsApprovalContext();
    if (ctx === undefined) return { kind: "timeout" };
    const channel = this.deps.ownerChannelFor(ctx.ownerEmail);
    if (channel === undefined) return { kind: "timeout" };
    if (confirmText.length > CONFIRM_TYPED_MAX) return { kind: "timeout" };
    const requestId = randomUUID();
    this.last = requestId;
    const outcome = new Promise<RemoteApprovalOutcome>((resolve) => {
      this.pending.set(requestId, {
        kind: "confirm",
        ownerExternalId: ctx.ownerExternalId,
        channelId: channel,
        label: ctx.actionLabel,
        confirmText,
        resolve,
      });
    });
    const platform = this.deps.platformFor?.(channel) ?? "slack";
    const card = confirmCardFor(platform, {
      requestId,
      label: ctx.actionLabel,
      confirmText,
    });
    await this.postOrDrop(
      requestId,
      channel,
      `Approval needed from ${ctx.ownerEmail}: ${clipLabel(ctx.actionLabel)} (requested by ${ctx.requesterExternalId}). ${confirmFallbackLine(confirmText)}`,
      card,
    );
    return await outcome;
  }

  private async postOrDrop(
    requestId: string,
    channel: string,
    text: string,
    card?: ChatCard,
  ): Promise<void> {
    try {
      await (card === undefined
        ? this.deps.post(channel, text)
        : this.deps.post(channel, text, card));
    } catch (err) {
      // The card was never shown to the owner (post failed, e.g. the I29 append-before-post
      // egress ledger rejected it) — this pending entry must not survive the failure, or a
      // later `resolveClick` on a stale/reused request id could still resolve `outcome`.
      this.pending.delete(requestId);
      throw err;
    }
  }

  /**
   * Called by the transport adapter when the owner clicks (or replies `reject`/`approve` in the
   * channel). On a confirm card a text `approve` never resolves it, and only the card's owner can
   * spend it: a non-owner cannot fall back (I20's fallback reaches a channel that cannot collect
   * typed text), so honouring theirs would only let a colleague abort the write.
   */
  resolveClick(click: ApprovalClick): boolean {
    const entry = this.pending.get(click.requestId);
    if (entry === undefined) return false;
    if (entry.kind === "confirm") {
      if (click.approved || click.approverExternalId !== entry.ownerExternalId) return false;
    }
    this.pending.delete(click.requestId);
    entry.resolve({ kind: "answered", peerId: click.approverExternalId, approved: click.approved });
    return true;
  }

  /** A Slack Confirm click: the card's text and channel, for its owner only. */
  resolveConfirmOpen(req: {
    readonly requestId: string;
    readonly clickerExternalId: string;
  }): ConfirmOpenDetails | undefined {
    const entry = this.pending.get(req.requestId);
    if (entry?.kind !== "confirm") return undefined;
    if (req.clickerExternalId !== entry.ownerExternalId) return undefined;
    return { channelId: entry.channelId, label: entry.label, confirmText: entry.confirmText };
  }

  /**
   * A modal or card submit. Resolves only from the card's owner (a non-owner leaves the card live).
   * `typed` is handed to the executor untouched, except that a non-string or over-cap value (only a
   * forged payload reaches it: the forms cap input) becomes the empty string, which the executor's
   * own comparison then fails: the presenter never decides the verdict from the text (D41).
   */
  resolveConfirmSubmit(sub: ConfirmSubmit): boolean {
    const entry = this.pending.get(sub.requestId);
    if (entry?.kind !== "confirm") return false;
    if (sub.approverExternalId !== entry.ownerExternalId) return false;
    this.pending.delete(sub.requestId);
    if (!sub.approved) {
      entry.resolve({ kind: "answered", peerId: sub.approverExternalId, approved: false });
      return true;
    }
    // A shape check (a non-string or over-cap value is a forged payload), not a judgement of what
    // was typed: only the executor compares it with the confirm text (D41).
    const raw: unknown = sub.typed;
    const typed = typeof raw === "string" && raw.length <= CONFIRM_TYPED_MAX ? raw : "";
    entry.resolve({ kind: "answered", peerId: sub.approverExternalId, approved: true, typed });
    return true;
  }
}
