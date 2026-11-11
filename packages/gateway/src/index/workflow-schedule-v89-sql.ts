/**
 * V89 — scheduled workflows and blocked runs (Phase 10 SA4, spec § 6.2 / § 6.3).
 *
 * `workflow.schedule` (a 5-field cron), `schedule_tz` (an IANA zone, resolved once at save),
 * `schedule_next_at` and `schedule_last_fire_at` are written only by `workflow.save` and the
 * scheduler. `workflow_run` gains `blocked_step` / `blocked_at` (a run that stopped at a write step
 * with no standing rule), `trigger` (the run's derived trigger, kept for history and never read as
 * authority) and `workflow_sha256` (the hash of the definition the run executed, so a resume can
 * refuse a changed workflow; NULL on a pre-V89 row, which a resume refuses).
 *
 * `workflow_run.status` gains `blocked_on_approval` and `abandoned`; the column has no CHECK, so no
 * rebuild is needed.
 *
 * Backfill: none. Every existing workflow is unscheduled and every existing run keeps NULLs.
 */
export const WORKFLOW_SCHEDULE_V89_SQL = [
  "ALTER TABLE workflow ADD COLUMN schedule TEXT",
  "ALTER TABLE workflow ADD COLUMN schedule_tz TEXT",
  "ALTER TABLE workflow ADD COLUMN schedule_next_at INTEGER",
  "ALTER TABLE workflow ADD COLUMN schedule_last_fire_at INTEGER",
  "ALTER TABLE workflow_run ADD COLUMN blocked_step INTEGER",
  "ALTER TABLE workflow_run ADD COLUMN blocked_at INTEGER",
  "ALTER TABLE workflow_run ADD COLUMN trigger TEXT",
  "ALTER TABLE workflow_run ADD COLUMN workflow_sha256 TEXT",
  "CREATE INDEX IF NOT EXISTS idx_workflow_schedule_next ON workflow(schedule_next_at) WHERE schedule IS NOT NULL",
];
