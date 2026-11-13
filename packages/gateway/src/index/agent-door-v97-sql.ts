/**
 * V97 — the agent door's per-door approval list and the legacy flag (Phase 28 AD3a-1, spec
 * 2026-11-13 § 7.3, static rule D49(b)).
 *
 * 1. `connector_write_door_approval`: one row per (service, door, tool) the owner approved BY NAME
 *    for an outside agent (`nimbus connector writes enable <svc> --door agent`), with the SHA-256 of
 *    the tool's listed definition at approval. `suspended_at` / `suspended_sha256` record, stickily,
 *    that a later listing no longer matched; only a re-approval by name clears them. A suspension
 *    with a NULL `suspended_sha256` means the tool was no longer listed (or its schema could not be
 *    read), so there is no hash to record; a hash without a suspension time is refused. `door` has
 *    no value CHECK on purpose (the spec keeps it open for later doors); the store's type allows
 *    only `"agent"`. Written only by `connectors/connector-writes/door-approval-store.ts` (D49(b)).
 *    Backfill: none, so nothing is approved for any agent after an upgrade.
 * 2. `capture` is REBUILT (SQLite cannot alter a CHECK; the V69 precedent, every column named on both
 *    sides of the copy): a `legacy` flag (0 or 1, 1 only on an action) for AD3a-2's deprecation
 *    window, and the error-code CHECK now lets a `rejected` action carry a code (AD2 deferred
 *    that). Since AD3a-2a the capture gate writes `legacy = 1` and `finalizeAction` a code on a `rejected` row. `capture` is no
 *    FK parent and no trigger or view names it, so nothing cascades on the drop. Only this file, the
 *    V67/V69 files and `mcp-sink/capture-store.ts` name the table (static rule D32(a)).
 */
const V69_COLS = `id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id,
  native_ref, created_at, decided_at, expires_at, outcome_ref, error_code`;

export const CAPTURE_DOOR_V97_COUNT_SQL = "SELECT COUNT(*) AS n FROM capture";

/** `PRAGMA table_info(capture)`: the rebuild is skipped when `legacy` already exists (re-runnable). */
export const CAPTURE_DOOR_V97_PROBE_SQL = "PRAGMA table_info(capture)";

export const CONNECTOR_WRITE_DOOR_APPROVAL_V97_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connector_write_door_approval (
     service            TEXT NOT NULL,
     door               TEXT NOT NULL,
     tool_id            TEXT NOT NULL,
     approved_at        INTEGER NOT NULL,
     definition_sha256  TEXT NOT NULL CHECK (length(definition_sha256) = 64),
     suspended_at       INTEGER,
     suspended_sha256   TEXT CHECK (suspended_sha256 IS NULL OR length(suspended_sha256) = 64),
     CHECK (suspended_sha256 IS NULL OR suspended_at IS NOT NULL),
     PRIMARY KEY (service, door, tool_id)
   ) WITHOUT ROWID`,
];

export const CAPTURE_REBUILD_V97_SQL: readonly string[] = [
  `CREATE TABLE capture_v97 (
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
     legacy        INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
     CHECK (
       (kind = 'note' AND state IN ('live','revoked'))
       OR (kind IN ('decision','term','link') AND state IN ('proposed','accepted','rejected','revoked'))
       OR (kind = 'action' AND state IN ('proposed','executing','executed','failed','rejected','expired'))
     ),
     CHECK ((state = 'revoked') = (payload_json IS NULL)),
     CHECK ((kind = 'action') = (expires_at IS NOT NULL)),
     CHECK (kind <> 'action' OR (item_id IS NULL AND native_ref IS NULL)),
     CHECK (outcome_ref IS NULL OR (kind = 'action' AND state = 'executed' AND length(outcome_ref) <= 512)),
     CHECK (error_code IS NULL OR (kind = 'action' AND state IN ('failed','rejected') AND length(error_code) <= 64)),
     CHECK (legacy = 0 OR kind = 'action')
   )`,
  `INSERT INTO capture_v97 (${V69_COLS}) SELECT ${V69_COLS} FROM capture`,
  "DROP TABLE capture",
  "ALTER TABLE capture_v97 RENAME TO capture",
  "CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_capture_item_id ON capture(item_id) WHERE item_id IS NOT NULL",
];
