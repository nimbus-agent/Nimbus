export const AUDIT_SESSION_V24_SCHEMA_SQL = `
ALTER TABLE audit_log ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_log_session_id ON audit_log(session_id);
`;
