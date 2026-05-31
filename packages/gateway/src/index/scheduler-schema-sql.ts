export const SCHEDULER_V2_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS scheduler_state (
  service_id TEXT PRIMARY KEY,
  cursor TEXT,
  interval_ms INTEGER NOT NULL,
  last_sync_at INTEGER,
  next_sync_at INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  error_msg TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  items_upserted INTEGER NOT NULL DEFAULT 0,
  items_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER,
  had_more INTEGER NOT NULL DEFAULT 0,
  error_msg TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_telemetry_service ON sync_telemetry(service);
CREATE INDEX IF NOT EXISTS idx_sync_telemetry_started ON sync_telemetry(started_at);
`;
