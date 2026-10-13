/**
 * V67 — the MCP capture sink's queue (spec 2026-10-11 § 4.1, invariant I28).
 *
 * Only `mcp-sink/capture-store.ts` names this table at runtime (static rule D32(a)); this module is
 * the other allow-listed file. `session_id` is kept for forensics and deliberately NOT indexed: it
 * is a per-connection UUID, useless as a rate-limit key. `idx_capture_created` serves the durable
 * hourly cap and retention.
 */
export const CAPTURE_V67_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS capture (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link')),
     state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked')),
     item_id       TEXT,
     payload_json  TEXT,
     payload_bytes INTEGER NOT NULL,
     client_label  TEXT,
     session_id    TEXT NOT NULL,
     native_ref    TEXT,
     created_at    INTEGER NOT NULL,
     decided_at    INTEGER,
     CHECK (
       (kind = 'note' AND state IN ('live','revoked'))
       OR (kind <> 'note' AND state IN ('proposed','accepted','rejected','revoked'))
     ),
     CHECK ((state = 'revoked') = (payload_json IS NULL))
   )`,
  "CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at)",
  // stateOfItem (gate step 6) looks a capture up by its item; partial, since revoked rows hold NULL.
  "CREATE INDEX IF NOT EXISTS idx_capture_item_id ON capture(item_id) WHERE item_id IS NOT NULL",
];
