/**
 * V39 — tribal_clusters: the asker-side cluster ledger for Phase 6 Slice 6c
 * (tribal-knowledge extraction). One row per detected repeated-question cluster;
 * survives restarts, dedups suggestions, and tracks capture/dismiss + cooldown state.
 */
export const TRIBAL_CLUSTERS_V39_SQL = `
CREATE TABLE IF NOT EXISTS tribal_clusters (
  cluster_id              TEXT PRIMARY KEY,
  representative_question  TEXT NOT NULL,
  representative_vec       BLOB,
  occurrence_count         INTEGER NOT NULL DEFAULT 1,
  first_seen               INTEGER NOT NULL,
  last_seen                INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  channel_id               TEXT NOT NULL,
  platform                 TEXT NOT NULL,
  suggested_at             INTEGER,
  cooldown_until           INTEGER,
  captured_page_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tribal_clusters_status ON tribal_clusters(status);
CREATE INDEX IF NOT EXISTS idx_tribal_clusters_channel ON tribal_clusters(channel_id);
`;
