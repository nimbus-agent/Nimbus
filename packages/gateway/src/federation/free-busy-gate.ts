import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { buildReply, type FreeBusyReply, validateWindow } from "./_lib/free-busy-blocks.ts";
import { calendarReadiness, readBusyBlocks } from "./_lib/free-busy-read.ts";
import type { FreeBusyLimiter } from "./free-busy-limiter.ts";
import type { ScheduleApprovalInput } from "./schedule-consent-broker.ts";

/**
 * I17 (b) — the ONLY path that answers an inbound `federation.freeBusy` (Phase 10, OR-S4-SCHED).
 * Order: identity (I18) → the window is valid → the per-peer limit → the LOCAL owner approves THIS
 * request (naming the peer and the window) → the local calendar is fresh enough to say "free" →
 * read → answer. Nothing is read before the owner approves.
 *
 * The answer is `FreeBusyReply` and nothing else: 30-minute blocks as a `0`/`1` string. No title,
 * attendee, place, organiser, calendar name or id is read, held or sent (`free-busy-read.ts` selects
 * only `metadata` and parses five keys), and the reply has no field a busy block's origin could fill.
 *
 * Refusals are FIXED codes. A denial, an owner who never answers, and an invalid operator identity
 * all return the same `declined`; it is distinguishable from an empty calendar (which answers `ok`
 * with all-free blocks) on purpose: a refusal that read as "free all week" would make a peer book
 * over a meeting the owner simply did not want to disclose. `declined` carries no information about
 * the owner's events.
 */
export type FreeBusyWireError =
  | "declined"
  | "invalid_window"
  | "rate_limited"
  | "calendar_unavailable";

export type FreeBusyResult =
  | { readonly kind: "ok"; readonly reply: FreeBusyReply }
  | { readonly kind: "error"; readonly error: FreeBusyWireError };

export interface FreeBusyGateCtx {
  readonly db: Database;
  readonly limiter: FreeBusyLimiter;
  /** The LOCAL owner's approval of one request (ScheduleConsentBroker.request). */
  readonly requestApproval: (input: ScheduleApprovalInput) => Promise<boolean>;
  readonly now?: () => number;
  /** I18: when identity is enabled, the operator must be valid to serve. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

/** `peerId` is the NaCl-authenticated session id (I17/R1); `fromMs`/`toMs` are untrusted. */
export interface InboundFreeBusy {
  readonly peerId: string;
  readonly fromMs: unknown;
  readonly toMs: unknown;
}

type Decision =
  | "answered"
  | "declined"
  | "invalid"
  | "rate_limited"
  | "unavailable"
  | "identity_invalid";

function audit(
  ctx: FreeBusyGateCtx,
  q: InboundFreeBusy,
  decision: Decision,
  extra: Record<string, number | boolean> = {},
): void {
  let hitlStatus: "approved" | "rejected" | "not_required" = "not_required";
  if (decision === "answered" || decision === "unavailable") hitlStatus = "approved";
  else if (decision === "declined") hitlStatus = "rejected";
  const fromMs = typeof q.fromMs === "number" ? q.fromMs : null;
  const toMs = typeof q.toMs === "number" ? q.toMs : null;
  // Counts and the window only: never an event field.
  appendAuditEntry(ctx.db, {
    actionType: `federation.freebusy.${decision}`,
    hitlStatus,
    actionJson: JSON.stringify({ peerId: q.peerId, fromMs, toMs, ...extra }),
    timestamp: (ctx.now ?? Date.now)(),
  });
}

export async function answerFederatedFreeBusy(
  ctx: FreeBusyGateCtx,
  q: InboundFreeBusy,
): Promise<FreeBusyResult> {
  const nowMs = (ctx.now ?? Date.now)();
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    audit(ctx, q, "identity_invalid");
    return { kind: "error", error: "declined" };
  }
  const window = validateWindow(q.fromMs, q.toMs, nowMs);
  if (window === undefined) {
    audit(ctx, q, "invalid");
    return { kind: "error", error: "invalid_window" };
  }
  if (!ctx.limiter.tryAcquire(q.peerId, nowMs)) {
    audit(ctx, q, "rate_limited");
    return { kind: "error", error: "rate_limited" };
  }
  let approved: boolean;
  try {
    approved = await ctx.requestApproval({
      peerId: q.peerId,
      fromMs: window.fromMs,
      toMs: window.toMs,
    });
  } finally {
    ctx.limiter.release(q.peerId);
  }
  if (!approved) {
    audit(ctx, q, "declined");
    return { kind: "error", error: "declined" };
  }
  const read =
    calendarReadiness(ctx.db, (ctx.now ?? Date.now)()) === "ready"
      ? readBusyBlocks(ctx.db, window)
      : undefined;
  // A capped scan could miss events: fail closed rather than say "free".
  if (read === undefined || read.capped) {
    audit(ctx, q, "unavailable", { capped: read?.capped ?? false });
    return { kind: "error", error: "calendar_unavailable" };
  }
  audit(ctx, q, "answered", { scanned: read.scanned, unreadable: read.unreadable });
  return { kind: "ok", reply: buildReply(window, read.blocks) };
}
