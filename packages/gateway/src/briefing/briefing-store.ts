import type { Database } from "bun:sqlite";

import type { BriefingCounts } from "../agents/_lib/briefing-types.ts";
import { dbRun } from "../db/write.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";

/**
 * The ONLY writer of `briefing_run` and `deadline_notice` (Phase 10 MB5, schema V93). Every statement is
 * bound-parameter SQL through `dbRun` (I9, I14).
 */

export type BriefingFiredBy = "schedule" | "manual";
export type BriefingStatus = "ok" | "skipped" | "failed";

export interface BriefingRunSummary {
  readonly id: string;
  readonly firedAt: number;
  readonly firedBy: BriefingFiredBy;
  readonly status: BriefingStatus;
  readonly headline: string;
  readonly counts: BriefingCounts | null;
  readonly toastOutcome: ToastOutcome | null;
  readonly slotAt: number | null;
  readonly errorMsg: string | null;
}

export interface BriefingRunView extends BriefingRunSummary {
  readonly markdown: string | null;
}

export interface NewBriefingRun {
  readonly firedAt: number;
  readonly firedBy: BriefingFiredBy;
  readonly status: BriefingStatus;
  readonly headline: string;
  readonly markdown?: string | null;
  readonly counts?: BriefingCounts | null;
  readonly toastOutcome?: ToastOutcome | null;
  readonly slotAt?: number | null;
  readonly errorMsg?: string | null;
}

export interface DeadlineNotice {
  readonly itemId: string;
  readonly dueAtMs: number;
  readonly notifiedAt: number;
}

/** A `schedule` run or skip for a slot that already has a row. Nothing was inserted. */
export class SlotTakenError extends Error {
  override readonly name = "SlotTakenError";
  constructor(readonly slotAt: number) {
    super(`briefing slot ${String(slotAt)} already has a run`);
  }
}

type RunRow = {
  id: string;
  fired_at: number;
  fired_by: BriefingFiredBy;
  status: BriefingStatus;
  headline: string;
  markdown: string | null;
  counts_json: string | null;
  toast_outcome: string | null;
  slot_at: number | null;
  error_msg: string | null;
};

const SUMMARY_COLUMNS =
  "id, fired_at, fired_by, status, headline, NULL AS markdown, counts_json, toast_outcome, slot_at, error_msg";
const VIEW_COLUMNS =
  "id, fired_at, fired_by, status, headline, markdown, counts_json, toast_outcome, slot_at, error_msg";

const COUNT_KEYS = [
  "meetings",
  "onCallShifts",
  "incidents",
  "reviews",
  "ticketsDue",
  "unreadMail",
  "unreadChat",
] as const;

function parseCounts(json: string | null): BriefingCounts | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of COUNT_KEYS) {
    const v = rec[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out as unknown as BriefingCounts;
}

function toView(r: RunRow): BriefingRunView {
  return {
    id: r.id,
    firedAt: r.fired_at,
    firedBy: r.fired_by,
    status: r.status,
    headline: r.headline,
    counts: parseCounts(r.counts_json),
    toastOutcome: r.toast_outcome as ToastOutcome | null,
    slotAt: r.slot_at,
    errorMsg: r.error_msg,
    markdown: r.markdown,
  };
}

function toSummary(r: RunRow): BriefingRunSummary {
  const { markdown: _m, ...summary } = toView(r);
  return summary;
}

export interface BriefingStore {
  insertRun(run: NewBriefingRun): string;
  setToastOutcome(id: string, outcome: ToastOutcome): void;
  latestOk(): BriefingRunView | null;
  list(limit: number): BriefingRunSummary[];
  get(id: string): BriefingRunView | null;
  /** The durable "last fire": the largest slot any run or skip answered, or `null`. */
  lastSlotAt(): number | null;
  /** The newest run of any status (for `status`). */
  lastRun(): BriefingRunSummary | null;
  pruneRuns(olderThanMs: number): number;
  getNotice(itemId: string): DeadlineNotice | null;
  insertNotice(n: DeadlineNotice): void;
  updateNotice(n: DeadlineNotice): void;
  pruneNotices(dueBeforeMs: number): number;
}

export function createBriefingStore(db: Database): BriefingStore {
  return {
    insertRun(run) {
      const id = crypto.randomUUID();
      const slotAt = run.slotAt ?? null;
      const res = dbRun(
        db,
        `INSERT INTO briefing_run
           (id, fired_at, fired_by, status, headline, markdown, counts_json, toast_outcome, slot_at, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slot_at) WHERE slot_at IS NOT NULL DO NOTHING`,
        [
          id,
          run.firedAt,
          run.firedBy,
          run.status,
          run.headline,
          run.markdown ?? null,
          run.counts === undefined || run.counts === null ? null : JSON.stringify(run.counts),
          run.toastOutcome ?? null,
          slotAt,
          run.errorMsg ?? null,
        ],
      );
      if (res.changes === 0 && slotAt !== null) throw new SlotTakenError(slotAt);
      return id;
    },
    setToastOutcome(id, outcome) {
      dbRun(db, "UPDATE briefing_run SET toast_outcome = ? WHERE id = ?", [outcome, id]);
    },
    latestOk() {
      const r = db
        .query(
          `SELECT ${VIEW_COLUMNS} FROM briefing_run WHERE status = 'ok' ORDER BY fired_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as RunRow | null;
      return r === null ? null : toView(r);
    },
    list(limit) {
      const rows = db
        .query(
          `SELECT ${SUMMARY_COLUMNS} FROM briefing_run ORDER BY fired_at DESC, rowid DESC LIMIT ?`,
        )
        .all(limit) as RunRow[];
      return rows.map(toSummary);
    },
    get(id) {
      const r = db
        .query(`SELECT ${VIEW_COLUMNS} FROM briefing_run WHERE id = ?`)
        .get(id) as RunRow | null;
      return r === null ? null : toView(r);
    },
    lastSlotAt() {
      const r = db.query("SELECT MAX(slot_at) AS m FROM briefing_run").get() as {
        m: number | null;
      } | null;
      return r?.m ?? null;
    },
    lastRun() {
      const r = db
        .query(
          `SELECT ${SUMMARY_COLUMNS} FROM briefing_run ORDER BY fired_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as RunRow | null;
      return r === null ? null : toSummary(r);
    },
    pruneRuns(olderThanMs) {
      return dbRun(db, "DELETE FROM briefing_run WHERE fired_at < ?", [olderThanMs]).changes;
    },
    getNotice(itemId) {
      const r = db
        .query("SELECT item_id, due_at_ms, notified_at FROM deadline_notice WHERE item_id = ?")
        .get(itemId) as { item_id: string; due_at_ms: number; notified_at: number } | null;
      return r === null
        ? null
        : { itemId: r.item_id, dueAtMs: r.due_at_ms, notifiedAt: r.notified_at };
    },
    insertNotice(n) {
      dbRun(db, "INSERT INTO deadline_notice (item_id, due_at_ms, notified_at) VALUES (?, ?, ?)", [
        n.itemId,
        n.dueAtMs,
        n.notifiedAt,
      ]);
    },
    updateNotice(n) {
      dbRun(db, "UPDATE deadline_notice SET due_at_ms = ?, notified_at = ? WHERE item_id = ?", [
        n.dueAtMs,
        n.notifiedAt,
        n.itemId,
      ]);
    },
    pruneNotices(dueBeforeMs) {
      return dbRun(db, "DELETE FROM deadline_notice WHERE due_at_ms < ?", [dueBeforeMs]).changes;
    },
  };
}
