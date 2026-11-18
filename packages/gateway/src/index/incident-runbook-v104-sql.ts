/**
 * V104 - the per-record state of an owner-authored runbook's steps (Phase 10 IC6, incident-engine spec § 5.6,
 * invariant I57 (c)).
 *
 * `incident_runbook_step`: one row per (incident record, runbook, step) the owner has acted on. `runbook_sha256`
 * is the content hash of the runbook file when the step was acted on; a row whose hash differs from the runbook's
 * current hash is ignored by the reader, so an edited runbook starts fresh. `status` is `done` (a check the owner
 * marked), `running` (an action or read claimed by this gateway), `ok`, `denied` or `failed`. `action_id` is the
 * executor action id of a read or action step. No read result and no tool input is stored.
 *
 * NO foreign key to `incident_record`, by design (as V102): a pruned record must not erase the fact that a step
 * ran. An owner erasure deletes the rows of the records it erases (`incident/incident-erasure.ts`). Written ONLY
 * by `runbook/runbook-store.ts` (static D46(g)). Backfill: none. Re-runnable (IF NOT EXISTS only).
 */
export const INCIDENT_RUNBOOK_V104_SQL = [
  `CREATE TABLE IF NOT EXISTS incident_runbook_step (
  record_id       TEXT NOT NULL,
  runbook         TEXT NOT NULL CHECK (length(runbook) BETWEEN 1 AND 64),
  runbook_sha256  TEXT NOT NULL CHECK (length(runbook_sha256) = 64),
  step            INTEGER NOT NULL CHECK (step >= 1 AND step <= 50),
  status          TEXT NOT NULL CHECK (status IN ('done', 'running', 'ok', 'denied', 'failed')),
  action_id       TEXT,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (record_id, runbook, step)
)`,
];
