/**
 * V63 — fleet subject enumeration (S2 fleets PR 2b).
 *
 * `fleet_brief` gains `subject_key TEXT NOT NULL`. SQLite cannot add a NOT NULL column without a
 * default, and a default would write a placeholder into history, so the table is REBUILT (the V46
 * glossary precedent). The backfill `subject_key = job_id` is true history, not a stand-in: for a
 * config-named job the subject IS the job.
 *
 * The rebuild keeps `run_id … REFERENCES fleet_run(id) ON DELETE CASCADE` — a rebuild is where that
 * silently disappears — and `DROP TABLE` drops every index, so all four are recreated after the
 * rename. Columns are named explicitly, never `SELECT *`.
 *
 * `fleet_job_state` gains the sweep cursor (a KEY, not an ordinal: an ordinal shifts when a subject
 * is added or deleted). `fleet_run` gains subject counters so a run row stays self-describing when
 * one job produced many briefs.
 */
export const FLEET_SUBJECTS_V63_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fleet_brief_v63 (
     id              TEXT PRIMARY KEY,
     run_id          TEXT NOT NULL REFERENCES fleet_run(id) ON DELETE CASCADE,
     job_id          TEXT NOT NULL,
     subject_key     TEXT NOT NULL,
     agent_method    TEXT NOT NULL,
     brief_markdown  TEXT,
     findings_json   TEXT NOT NULL,
     synthesis_json  TEXT,
     created_at      INTEGER NOT NULL,
     expires_at      INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `INSERT INTO fleet_brief_v63 (
     id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json,
     synthesis_json, created_at, expires_at
   )
   SELECT
     id, run_id, job_id, job_id, agent_method, brief_markdown, findings_json,
     synthesis_json, created_at, expires_at
   FROM fleet_brief`,
  "DROP TABLE fleet_brief",
  "ALTER TABLE fleet_brief_v63 RENAME TO fleet_brief",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_run ON fleet_brief (run_id)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_job ON fleet_brief (job_id, subject_key, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_subject ON fleet_brief (subject_key, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_expires ON fleet_brief (expires_at)",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_kind TEXT",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_cursor TEXT",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_subjects_total INTEGER",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_empty_reason TEXT",
  "ALTER TABLE fleet_run ADD COLUMN subjects_in_scope INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE fleet_run ADD COLUMN subjects_attempted INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE fleet_run ADD COLUMN subjects_completed INTEGER NOT NULL DEFAULT 0",
];
