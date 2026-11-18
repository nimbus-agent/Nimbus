import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

/**
 * The ONLY writer of `incident_runbook_step` (Phase 10 IC6, V104, static D46(g)): the per-record state of an
 * owner-authored runbook's steps. Stores a status and an action id; never a read result, a tool input or a title.
 * Imports nothing from `connectors/`, `runbook/` or the engine (it is inside the D46(a) scope).
 */

export type RunbookStepStatus = "done" | "running" | "ok" | "denied" | "failed";

export type RunbookStepRow = {
  readonly record_id: string;
  readonly runbook: string;
  readonly runbook_sha256: string;
  readonly step: number;
  readonly status: RunbookStepStatus;
  readonly action_id: string | null;
  readonly updated_at_ms: number;
};

/** The step rows of one runbook on one record, for the runbook's CURRENT hash only (an edit starts fresh). */
export function listRunbookSteps(
  db: Database,
  recordId: string,
  runbook: string,
  sha256: string,
): RunbookStepRow[] {
  return db
    .query(
      `SELECT record_id, runbook, runbook_sha256, step, status, action_id, updated_at_ms
         FROM incident_runbook_step
        WHERE record_id = ? AND runbook = ? AND runbook_sha256 = ?
        ORDER BY step`,
    )
    .all(recordId, runbook, sha256) as RunbookStepRow[];
}

/** Mark a check step done (idempotent). */
export function markRunbookStepDone(
  db: Database,
  key: { recordId: string; runbook: string; sha256: string; step: number },
  nowMs: number,
): void {
  dbRun(
    db,
    `INSERT INTO incident_runbook_step (record_id, runbook, runbook_sha256, step, status, action_id, updated_at_ms)
     VALUES (?, ?, ?, ?, 'done', NULL, ?)
     ON CONFLICT (record_id, runbook, step) DO UPDATE SET
       runbook_sha256 = excluded.runbook_sha256, status = 'done', action_id = NULL, updated_at_ms = excluded.updated_at_ms`,
    [key.recordId, key.runbook, key.sha256, key.step, nowMs],
  );
}

/**
 * Record that a read or action step started, with its action id. The caller (`runbook/runbook-run.ts`) holds the
 * in-process claim: only one gateway process runs, and it refuses a step it is already running before it calls
 * this, so a `running` row it finds here is a leftover of a gateway that stopped mid-step and is overwritten.
 */
export function startRunbookStep(
  db: Database,
  key: { recordId: string; runbook: string; sha256: string; step: number },
  actionId: string,
  nowMs: number,
): void {
  dbRun(
    db,
    `INSERT INTO incident_runbook_step (record_id, runbook, runbook_sha256, step, status, action_id, updated_at_ms)
     VALUES (?, ?, ?, ?, 'running', ?, ?)
     ON CONFLICT (record_id, runbook, step) DO UPDATE SET
       runbook_sha256 = excluded.runbook_sha256, status = 'running', action_id = excluded.action_id,
       updated_at_ms = excluded.updated_at_ms`,
    [key.recordId, key.runbook, key.sha256, key.step, actionId, nowMs],
  );
}

/** Record the outcome of a started step (only its own action id moves it). Returns whether it moved. */
export function finishRunbookStep(
  db: Database,
  key: { recordId: string; runbook: string; step: number },
  actionId: string,
  status: "ok" | "denied" | "failed",
  nowMs: number,
): boolean {
  const res = dbRun(
    db,
    `UPDATE incident_runbook_step SET status = ?, updated_at_ms = ?
      WHERE record_id = ? AND runbook = ? AND step = ? AND action_id = ? AND status = 'running'`,
    [status, nowMs, key.recordId, key.runbook, key.step, actionId],
  );
  return res.changes === 1;
}

/** An owner erasure: delete the step rows of the erased records. */
export function deleteRunbookStepsForRecords(db: Database, recordIds: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < recordIds.length; i += 500) {
    const chunk = recordIds.slice(i, i + 500);
    n += dbRun(
      db,
      `DELETE FROM incident_runbook_step WHERE record_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    ).changes;
  }
  return n;
}
