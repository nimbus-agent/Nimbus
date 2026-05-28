export const TOOL_CALL_LOG_V29_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tool_call_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT,
  tool_id         TEXT NOT NULL,
  service         TEXT NOT NULL,
  called_at       INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  result_envelope TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('ok','error'))
);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_session   ON tool_call_log(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_tool_time ON tool_call_log(tool_id, called_at);
CREATE INDEX IF NOT EXISTS idx_tool_call_log_called_at ON tool_call_log(called_at);
`;
