/**
 * V69 — the MCP act door (spec 2026-10-15 § 4, invariant I28, S3 PR 3).
 *
 * `capture` admits a fifth kind, `action`, four action states, and three nullable columns. SQLite
 * cannot alter a CHECK, so the table is REBUILT with every column named on both sides of the copy
 * (the V68 precedent). `capture` is no FK parent, so no cascade can fire on the drop. Only this file
 * and `mcp-sink/capture-store.ts` name the table (static rule D32(a)).
 */
const V68_COLS = `id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id,
  native_ref, created_at, decided_at`;

export const CAPTURE_ACTION_V69_COUNT_SQL = "SELECT COUNT(*) AS n FROM capture";

export const CAPTURE_ACTION_V69_SQL: readonly string[] = [
  `CREATE TABLE capture_v69 (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link','action')),
     state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked',
                                                 'executing','executed','failed','expired')),
     item_id       TEXT,
     payload_json  TEXT,
     payload_bytes INTEGER NOT NULL,
     client_label  TEXT,
     session_id    TEXT NOT NULL,
     native_ref    TEXT,
     created_at    INTEGER NOT NULL,
     decided_at    INTEGER,
     expires_at    INTEGER,
     outcome_ref   TEXT,
     error_code    TEXT,
     CHECK (
       (kind = 'note' AND state IN ('live','revoked'))
       OR (kind IN ('decision','term','link') AND state IN ('proposed','accepted','rejected','revoked'))
       OR (kind = 'action' AND state IN ('proposed','executing','executed','failed','rejected','expired'))
     ),
     CHECK ((state = 'revoked') = (payload_json IS NULL)),
     CHECK ((kind = 'action') = (expires_at IS NOT NULL)),
     CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL)),
     CHECK (outcome_ref IS NULL OR (kind = 'action' AND state = 'executed' AND length(outcome_ref) <= 512)),
     CHECK (error_code IS NULL OR (kind = 'action' AND state = 'failed' AND length(error_code) <= 64))
   )`,
  `INSERT INTO capture_v69 (${V68_COLS}) SELECT ${V68_COLS} FROM capture`,
  "DROP TABLE capture",
  "ALTER TABLE capture_v69 RENAME TO capture",
  "CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_capture_item_id ON capture(item_id) WHERE item_id IS NOT NULL",
];
