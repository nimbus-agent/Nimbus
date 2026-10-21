/**
 * V73 — Readwise unbundling, gateway PR 5. Three additive changes in one step:
 *
 * - `connector_migration`: one row per bundled connector being moved to a registry-installed
 *   extension (written by the migration path in a later task). `legacy_service_id` is UNIQUE: a
 *   legacy connector is migrated at most once, so the table itself is the dedup.
 * - `builtin_registry_state`: I44's anti-rollback floor for the BUILT-IN official registry, keyed by
 * - `builtin_registry_state`: I44's anti-rollback floor for the BUILT-IN official registry, keyed by
 *   its reserved name and the root key it was recorded under (a re-pinned root starts a fresh floor,
 *   like an owner row). The built-in registry is not a row of the owner's `extension_registry`, so
 * - `sync_telemetry.items_dropped`: extension sync items a run refused, written by the scheduler
 *   on every telemetry row (`SyncResult.dropped` summed, else 0) and read back by
 *   `nimbus connector status --stats`. `NOT NULL DEFAULT 0`, so every existing row reads 0.
 */
export const CONNECTOR_MIGRATION_V73_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS connector_migration (
     id                TEXT PRIMARY KEY,
     legacy_service_id TEXT NOT NULL,
     extension_id      TEXT NOT NULL,
     version           TEXT,
     tree_digest       TEXT,
     stage_path        TEXT,
     state             TEXT NOT NULL CHECK (state IN ('awaiting_approval','approved','declined','failed')),
     error             TEXT,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL
   )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_migration_legacy_service ON connector_migration (legacy_service_id)",
  `CREATE TABLE IF NOT EXISTS builtin_registry_state (
     name              TEXT PRIMARY KEY,
     root_key          TEXT NOT NULL,
     last_sequence     INTEGER NOT NULL,
     last_generated_at TEXT,
     last_fetched_at   INTEGER
   )`,
  "ALTER TABLE sync_telemetry ADD COLUMN items_dropped INTEGER NOT NULL DEFAULT 0",
];
