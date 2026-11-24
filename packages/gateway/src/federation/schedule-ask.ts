import type { Database } from "bun:sqlite";
import {
  commonFreeSlots,
  type FreeBusyWindow,
  parseReply,
  type Slot,
  validateWindow,
} from "./_lib/free-busy-blocks.ts";
import { calendarReadiness, readBusyBlocks } from "./_lib/free-busy-read.ts";

/**
 * The asking side of federated scheduling (Phase 10, OR-S4-SCHED): ask one paired peer for its
 * free/busy blocks over the window, read OUR OWN blocks from the local index (no prompt: it is the
 * owner's own calendar and nothing leaves), and intersect. The peer's answer is parsed strictly
 * (`parseReply`); what is returned names only slots, never a block's origin.
 */
export type ScheduleAskError =
  | "declined"
  | "invalid_window"
  | "rate_limited"
  | "calendar_unavailable"
  | "own_calendar_unavailable"
  | "peer_unreachable"
  | "malformed_reply";

export type ScheduleAskResult =
  | {
      readonly kind: "ok";
      readonly window: FreeBusyWindow;
      readonly durationMs: number;
      readonly slots: readonly Slot[];
    }
  | { readonly kind: "error"; readonly error: ScheduleAskError };

export interface ScheduleAskDeps {
  readonly db: Database;
  /** Sends `federation.freeBusy { fromMs, toMs }` to the chosen peer and returns its raw result. */
  readonly send: (params: { fromMs: number; toMs: number }) => Promise<unknown>;
  readonly now?: () => number;
}

const PEER_ERRORS: ReadonlySet<string> = new Set([
  "declined",
  "invalid_window",
  "rate_limited",
  "calendar_unavailable",
]);

function peerError(raw: unknown): ScheduleAskError | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const e = r["error"];
  return r["kind"] === "error" && typeof e === "string" && PEER_ERRORS.has(e)
    ? (e as ScheduleAskError)
    : undefined;
}

export async function askPeerFreeBusy(
  deps: ScheduleAskDeps,
  input: { fromMs: number; toMs: number; durationMs: number },
): Promise<ScheduleAskResult> {
  const nowMs = (deps.now ?? Date.now)();
  const window = validateWindow(input.fromMs, input.toMs, nowMs);
  if (window === undefined) return { kind: "error", error: "invalid_window" };
  if (calendarReadiness(deps.db, nowMs) !== "ready") {
    return { kind: "error", error: "own_calendar_unavailable" };
  }
  const mine = readBusyBlocks(deps.db, window);
  if (mine.capped) return { kind: "error", error: "own_calendar_unavailable" };

  let raw: unknown;
  try {
    raw = await deps.send({ fromMs: window.fromMs, toMs: window.toMs });
  } catch {
    return { kind: "error", error: "peer_unreachable" };
  }
  const refused = peerError(raw);
  if (refused !== undefined) return { kind: "error", error: refused };
  const body = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const theirs = body["kind"] === "ok" ? parseReply(body["reply"], window) : undefined;
  if (theirs === undefined) return { kind: "error", error: "malformed_reply" };
  // The peer's owner took time to approve: a sync may have added an event since the first read.
  const after = (deps.now ?? Date.now)();
  if (calendarReadiness(deps.db, after) !== "ready") {
    return { kind: "error", error: "own_calendar_unavailable" };
  }
  const latest = readBusyBlocks(deps.db, window);
  if (latest.capped) return { kind: "error", error: "own_calendar_unavailable" };
  return {
    kind: "ok",
    window,
    durationMs: input.durationMs,
    slots: commonFreeSlots(window, latest.blocks, theirs, input.durationMs),
  };
}
