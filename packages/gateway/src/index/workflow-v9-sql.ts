export const WORKFLOW_V9_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workflow (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  steps_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_run (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  triggered_by TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  error_msg   TEXT
);

CREATE TABLE IF NOT EXISTS workflow_run_step (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,
  label       TEXT,
  status      TEXT NOT NULL,
  hitl_action TEXT,
  hitl_approved INTEGER,
  result_json TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_workflow ON workflow_run(workflow_id);
`;
