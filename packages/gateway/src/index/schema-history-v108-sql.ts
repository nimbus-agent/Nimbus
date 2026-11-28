/**
 * V108 - warehouse schema history (Phase 10, the Data Incident Brief's schema-diff input, owner ruling
 * OR-S4-DATA-INPUTS, static D24 rule `schema-history-confined`).
 *
 * `schema_history`: one row per OBSERVATION of a warehouse table's column set that CHANGED what the last row
 * for the same table said, plus one row when an observation turned incomplete. `columns_json` is the whole
 * column set (`[{ name, type, nullable }]`, sorted by name, metadata only: never a default, a value or a
 * comment), NULL on an incomplete row. `complete = 0` means the sync could not prove it saw every column (the
 * connector said so, the schema was never fetched, or the cap cut it): such a row is never compared with its
 * neighbours, so a missing column is never read as a dropped one. A diff is computed at read time between two
 * adjacent COMPLETE rows (`index/schema-diff.ts`); nothing here stores a diff.
 *
 * `data_model_key` is the shared `normalizeDataModelKey` form (`database.schema.table`, or
 * `project.dataset.table` for BigQuery), the key a Monte Carlo or Bigeye test monitors.
 * `observed_at_ms` is the sync's own time; it plays the role of the new-table checklist's `created_at`.
 *
 * NO foreign key and NO trigger, by design (the `item_history` rule): an upstream deletion must not erase the
 * history that says the table existed. An owner erasure (`connector remove`, `nimbus data delete`) deletes the
 * service's rows through `deleteSchemaHistoryForService`. Written ONLY by `index/schema-history.ts`.
 *
 * Backfill: none. Nothing earlier is recoverable; history begins at the upgrade. Re-runnable (IF NOT EXISTS).
 */
export const SCHEMA_HISTORY_V108_DESCRIPTION =
  "warehouse schema history (Phase 10, data incident brief)";

export const SCHEMA_HISTORY_V108_SQL = [
  `CREATE TABLE IF NOT EXISTS schema_history (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  data_model_key TEXT NOT NULL CHECK (length(data_model_key) BETWEEN 1 AND 512),
  observed_at_ms INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  column_count INTEGER CHECK (column_count IS NULL OR column_count >= 0),
  columns_json TEXT CHECK (columns_json IS NULL OR length(columns_json) <= 1048576),
  CHECK ((complete = 1 AND columns_json IS NOT NULL AND column_count IS NOT NULL)
      OR (complete = 0 AND columns_json IS NULL))
)`,
  "CREATE INDEX IF NOT EXISTS schema_history_table ON schema_history (service, data_model_key, id)",
  "CREATE INDEX IF NOT EXISTS schema_history_key_time ON schema_history (data_model_key, observed_at_ms)",
  "CREATE INDEX IF NOT EXISTS schema_history_observed ON schema_history (observed_at_ms)",
];
