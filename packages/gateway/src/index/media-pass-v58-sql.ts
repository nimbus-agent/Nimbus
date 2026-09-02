/**
 * V58 — the multimodal understanding pass cursor (spec § 6.2).
 *
 * SQLite-backed rather than in-memory so an interrupted pass resumes across a gateway restart,
 * which is the entire point of a budgeted pass over a large media library.
 *
 * Grants are NOT here: they land in V59 with PR 4. Schema is forward-only, so creating a table
 * three PRs before anything reads it would be drift waiting to happen.
 */
export const MEDIA_PASS_V58_SQL = `
CREATE TABLE IF NOT EXISTS media_pass_cursor (
  pass_id          TEXT PRIMARY KEY,
  service          TEXT,
  modality         TEXT,
  last_item_id     TEXT NOT NULL,
  processed_count  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
) WITHOUT ROWID;
`;
