// packages/gateway/src/standing/standing-suggestion-store.ts
// The ONLY writer of `standing_streak` and `standing_suggestion` (Phase 10 SA5, static D44(f)). It
// never touches the rule tables: a suggestion grants nothing, and accepting one is the same
// `standing.rule.create` owner approval as any rule. Every write goes through `dbRun` (I14); every
// value is a bound parameter (I9).
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

import { dbRun } from "../db/write.ts";

/** The unit a streak counts: one write step of one workflow at one content hash. */
export type StepKey = {
  readonly workflowId: string;
  readonly workflowSha256: string;
  readonly stepIndex: number;
};

/** What one run of the step does to its streak (OR-10-9). */
export type StepRunVerdict = "counts" | "resets" | "no_change";

export type SuggestionStatus = "open" | "accepted" | "dismissed" | "stale";

export type StandingSuggestion = StepKey & {
  readonly id: string;
  readonly createdAt: number;
  readonly streak: number;
  readonly status: SuggestionStatus;
  readonly ruleId: string | undefined;
  readonly closedAt: number | undefined;
};

type SuggestionRow = {
  id: string;
  created_at: number;
  workflow_id: string;
  workflow_sha256: string;
  step_index: number;
  streak: number;
  status: SuggestionStatus;
  rule_id: string | null;
  closed_at: number | null;
};

const SUGGESTION_COLUMNS =
  "id, created_at, workflow_id, workflow_sha256, step_index, streak, status, rule_id, closed_at";

function suggestionOf(r: SuggestionRow): StandingSuggestion {
  return {
    id: r.id,
    createdAt: r.created_at,
    workflowId: r.workflow_id,
    workflowSha256: r.workflow_sha256,
    stepIndex: r.step_index,
    streak: r.streak,
    status: r.status,
    ruleId: r.rule_id ?? undefined,
    closedAt: r.closed_at ?? undefined,
  };
}

/** `'ss_'` + 16 random hex characters. */
export function newSuggestionId(): string {
  return `ss_${randomBytes(8).toString("hex")}`;
}

/** The current streak of a step (0 when there is no row). */
export function streakOf(db: Database, key: StepKey): number {
  const row = db
    .query(
      "SELECT streak FROM standing_streak WHERE workflow_id = ? AND workflow_sha256 = ? AND step_index = ?",
    )
    .get(key.workflowId, key.workflowSha256, key.stepIndex) as { streak: number } | null;
  return row?.streak ?? 0;
}

/**
 * Applies one run's verdict to the step's streak and returns the new value. `no_change` writes
 * nothing. The read-modify-write is one transaction, so two runs of one step cannot lose a count.
 */
export function applyStepRun(
  db: Database,
  key: StepKey,
  verdict: StepRunVerdict,
  runId: string,
  now: number,
): number {
  if (verdict === "no_change") return streakOf(db, key);
  const apply = db.transaction((): number => {
    const next = verdict === "counts" ? streakOf(db, key) + 1 : 0;
    dbRun(
      db,
      `INSERT INTO standing_streak (workflow_id, workflow_sha256, step_index, streak, last_run_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workflow_id, workflow_sha256, step_index)
       DO UPDATE SET streak = excluded.streak, last_run_id = excluded.last_run_id,
                     updated_at = excluded.updated_at`,
      [key.workflowId, key.workflowSha256, key.stepIndex, next, runId, now],
    );
    return next;
  });
  return apply.immediate();
}

export function getSuggestion(db: Database, id: string): StandingSuggestion | undefined {
  const row = db
    .query(`SELECT ${SUGGESTION_COLUMNS} FROM standing_suggestion WHERE id = ?`)
    .get(id) as SuggestionRow | null;
  return row === null ? undefined : suggestionOf(row);
}

/** Suggestions, oldest first (then by id), optionally of one status. */
export function listSuggestions(db: Database, status?: SuggestionStatus): StandingSuggestion[] {
  const rows =
    status === undefined
      ? (db
          .query(`SELECT ${SUGGESTION_COLUMNS} FROM standing_suggestion ORDER BY created_at, id`)
          .all() as SuggestionRow[])
      : (db
          .query(
            `SELECT ${SUGGESTION_COLUMNS} FROM standing_suggestion WHERE status = ? ORDER BY created_at, id`,
          )
          .all(status) as SuggestionRow[]);
  return rows.map(suggestionOf);
}

/**
 * Records an `open` suggestion for the step, unless one is already open or the owner dismissed one
 * for this key (OR-10-10: a dismissal holds until the workflow's hash changes, and a new hash is a new
 * key). Returns the new suggestion, or `undefined` when nothing was recorded.
 */
export function openSuggestion(
  db: Database,
  key: StepKey,
  streak: number,
  now: number,
): StandingSuggestion | undefined {
  const open = db.transaction((): StandingSuggestion | undefined => {
    const blocking = db
      .query(
        `SELECT 1 AS x FROM standing_suggestion
         WHERE workflow_id = ? AND workflow_sha256 = ? AND step_index = ?
           AND status IN ('open', 'dismissed') LIMIT 1`,
      )
      .get(key.workflowId, key.workflowSha256, key.stepIndex);
    if (blocking !== null) return undefined;
    const id = newSuggestionId();
    dbRun(
      db,
      `INSERT INTO standing_suggestion (id, created_at, workflow_id, workflow_sha256, step_index, streak, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      [id, now, key.workflowId, key.workflowSha256, key.stepIndex, streak],
    );
    return getSuggestion(db, id);
  });
  return open.immediate();
}

/** The owner dismissed an open suggestion. `false` when it was not open. */
export function dismissSuggestion(db: Database, id: string, now: number): boolean {
  return (
    dbRun(
      db,
      "UPDATE standing_suggestion SET status = 'dismissed', closed_at = ? WHERE id = ? AND status = 'open'",
      [now, id],
    ).changes === 1
  );
}

/**
 * The owner approved the rule made from this suggestion. Closes it with the rule's id and zeroes the
 * step's streak, so the next suggestion is again N approvals by hand. `false` when it was not open.
 */
export function markAccepted(db: Database, id: string, ruleId: string, now: number): boolean {
  const accept = db.transaction((): boolean => {
    const s = getSuggestion(db, id);
    const changed =
      dbRun(
        db,
        "UPDATE standing_suggestion SET status = 'accepted', rule_id = ?, closed_at = ? WHERE id = ? AND status = 'open'",
        [ruleId, now, id],
      ).changes === 1;
    if (changed && s !== undefined) {
      dbRun(
        db,
        "UPDATE standing_streak SET streak = 0, updated_at = ? WHERE workflow_id = ? AND workflow_sha256 = ? AND step_index = ?",
        [now, s.workflowId, s.workflowSha256, s.stepIndex],
      );
    }
    return changed;
  });
  return accept.immediate();
}

/** Closes one open suggestion as stale (its workflow changed). `false` when it was not open. */
export function markStale(db: Database, id: string, now: number): boolean {
  return (
    dbRun(
      db,
      "UPDATE standing_suggestion SET status = 'stale', closed_at = ? WHERE id = ? AND status = 'open'",
      [now, id],
    ).changes === 1
  );
}

/**
 * The workflow's content hash is now `currentSha`: closes its open suggestions of any other hash as
 * stale and deletes the streaks of those hashes. Returns how many suggestions it closed.
 */
export function markStaleFor(
  db: Database,
  workflowId: string,
  currentSha: string,
  now: number,
): number {
  const close = db.transaction((): number => {
    const closed = dbRun(
      db,
      `UPDATE standing_suggestion SET status = 'stale', closed_at = ?
       WHERE workflow_id = ? AND workflow_sha256 <> ? AND status = 'open'`,
      [now, workflowId, currentSha],
    ).changes;
    dbRun(db, "DELETE FROM standing_streak WHERE workflow_id = ? AND workflow_sha256 <> ?", [
      workflowId,
      currentSha,
    ]);
    return closed;
  });
  return close.immediate();
}
