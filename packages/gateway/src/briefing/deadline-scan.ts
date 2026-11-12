import type { Database } from "bun:sqlite";

import { isOpenTicket, ticketDueAt } from "../agents/_lib/briefing-queries.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";
import { type DueService, dueInstant } from "./briefing-due.ts";
import type { BriefingStore } from "./briefing-store.ts";
import { deadlineToastText } from "./briefing-toast.ts";

/**
 * The 24-hour deadline notices (Phase 10 MB5). Reads the `assigned` snapshot of Jira, Linear and GitHub
 * issues and warns ONCE per item that is open, due within `lead_hours`, and has had no activity for
 * `quiet_hours`. It reads the index only: no provider request.
 *
 * Privacy by construction: the candidate query selects no title (or any text), and the toast is
 * `deadlineToastText(n, leadHours)`, numbers only.
 *
 * Exactly once: a `deadline_notice` row is written BEFORE the toast (at-most-once beats at-least-once for
 * a warning), and a second notice for the same item needs its raw due value to move by an hour or more.
 */
export const DEADLINE_CANDIDATE_SQL = `SELECT i.id, i.service, i.modified_at, i.metadata
  FROM work_snapshot w JOIN item i ON i.id = w.item_id
 WHERE w.relation = 'assigned' AND w.service IN ('jira','linear','github') AND i.type = 'issue'`;

const HOUR_MS = 3_600_000;
/** A moved due date re-notifies only when it moved by at least this much. */
export const RENOTIFY_SHIFT_MS = HOUR_MS;

export type DeadlineScanConfig = { readonly leadHours: number; readonly quietHours: number };

export type DeadlineScanDeps = {
  readonly db: Database;
  readonly store: BriefingStore;
  readonly nowMs: number;
  readonly tz: string;
  readonly cfg: DeadlineScanConfig;
  readonly toast: (title: string, body: string) => Promise<ToastOutcome>;
  readonly onError?: (err: unknown) => void;
};

export type DeadlineScanResult = {
  /** Open items inside the window and past the quiet period. */
  readonly candidates: number;
  /** Items whose notice was written by this scan. */
  readonly noticed: number;
  /** The toast outcome, or `null` when nothing was noticed. */
  readonly outcome: ToastOutcome | null;
};

type CandidateRow = { id: string; service: string; modified_at: number; metadata: string | null };

function parseMeta(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The raw due value of a row that should be warned about now, or `null`. */
function dueForNotice(row: CandidateRow, deps: DeadlineScanDeps): number | null {
  const { nowMs, tz, cfg } = deps;
  if (row.modified_at >= nowMs - cfg.quietHours * HOUR_MS) return null;
  const meta = parseMeta(row.metadata);
  if (meta === null) return null;
  const service = row.service as DueService;
  if (!isOpenTicket(service, meta)) return null;
  const dueAt = ticketDueAt(meta);
  if (dueAt === null) return null;
  const due = dueInstant(service, dueAt, tz);
  return due > nowMs && due <= nowMs + cfg.leadHours * HOUR_MS ? dueAt : null;
}

/** Writes or refreshes the notice; `true` when this scan should warn about the item. */
function recordNotice(deps: DeadlineScanDeps, itemId: string, dueAtMs: number): boolean {
  const existing = deps.store.getNotice(itemId);
  if (existing === null) {
    deps.store.insertNotice({ itemId, dueAtMs, notifiedAt: deps.nowMs });
    return true;
  }
  if (Math.abs(dueAtMs - existing.dueAtMs) >= RENOTIFY_SHIFT_MS) {
    deps.store.updateNotice({ itemId, dueAtMs, notifiedAt: deps.nowMs });
    return true;
  }
  return false;
}

export async function scanDeadlines(deps: DeadlineScanDeps): Promise<DeadlineScanResult> {
  const rows = deps.db.query(DEADLINE_CANDIDATE_SQL).all() as CandidateRow[];
  let candidates = 0;
  let noticed = 0;
  for (const row of rows) {
    const dueAt = dueForNotice(row, deps);
    if (dueAt === null) continue;
    candidates += 1;
    try {
      if (recordNotice(deps, row.id, dueAt)) noticed += 1;
    } catch (e) {
      // A write that throws drops THIS item from the count; the others still proceed.
      deps.onError?.(e);
    }
  }
  if (noticed === 0) return { candidates, noticed, outcome: null };
  const text = deadlineToastText(noticed, deps.cfg.leadHours);
  let outcome: ToastOutcome;
  try {
    outcome = await deps.toast(text.title, text.body);
  } catch (e) {
    // The notices are already written: a failing toast never un-warns an item.
    deps.onError?.(e);
    outcome = "failed";
  }
  return { candidates, noticed, outcome };
}

/** Deletes notices whose due date is more than 30 days past. */
export function pruneDeadlineNotices(store: BriefingStore, nowMs: number): number {
  return store.pruneNotices(nowMs - 30 * 24 * HOUR_MS);
}
