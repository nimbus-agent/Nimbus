// V41 — share_records ledger (Phase 6 Slice 8: Share & Virality).
// Persists redacted, signed shareable artifacts (transcripts, briefs) with their
// redaction set + provenance chain so a share can be listed, re-fetched by content
// hash, and pruned once expired. No row-level cloud data — only the share envelope.
export const SHARE_RECORDS_V41_SQL = `
CREATE TABLE IF NOT EXISTS share_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash        TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL,
  session_id          TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER,
  redaction_set_json  TEXT NOT NULL,
  provenance_json     TEXT NOT NULL,
  body_json           TEXT NOT NULL,
  sig_json            TEXT NOT NULL,
  sink                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_records_session ON share_records(session_id);
CREATE INDEX IF NOT EXISTS idx_share_records_created ON share_records(created_at);
`;
