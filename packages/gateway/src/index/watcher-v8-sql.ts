export const WATCHER_V8_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS watcher (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  condition_type  TEXT NOT NULL,
  condition_json  TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  action_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_fired_at   INTEGER
);

CREATE TABLE IF NOT EXISTS watcher_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id  TEXT NOT NULL REFERENCES watcher(id) ON DELETE CASCADE,
  fired_at    INTEGER NOT NULL,
  condition_snapshot TEXT NOT NULL,
  action_result      TEXT
);

CREATE INDEX IF NOT EXISTS idx_watcher_enabled ON watcher(enabled);
`;
