export const GDPR_V37_SQL = `
CREATE TABLE IF NOT EXISTS gdpr_purge_job (
  job_id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  completion_sig TEXT
);
CREATE TABLE IF NOT EXISTS gdpr_purge_request (
  job_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_ms INTEGER,
  deletion_record TEXT,
  PRIMARY KEY (job_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_gdpr_request_pending ON gdpr_purge_request (status);
`;
