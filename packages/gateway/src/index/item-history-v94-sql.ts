/**
 * V94 - item history (Phase 10 IC1, incident-engine spec § 5.1).
 *
 * `item_history`: one row per observed CHANGE to an allowlisted state key of an incident, PR, ticket,
 * error-issue or data-quality item, plus the pseudo-keys `__created` and `__deleted`. A row means "this
 * key went from `old_value` to `new_value`, as the sync observed it at `observed_at_ms`".
 * `observed_at_ms` plays the role of the new-table checklist's `created_at`. `source_at_ms` is the
 * provider's own time for the change when the item already carries one (a PR's `merged_at`).
 *
 * Written ONLY by `index/item-history.ts` (static D46(b)), inside `upsertIndexedItem` and the delete path.
 *
 * NO foreign key and NO delete trigger, by design: deleting an item must not erase the history that says
 * the item existed. An owner erasure (`connector remove`, `nimbus data delete`) deletes that service's
 * rows through `deleteItemHistoryForService`.
 *
 * The third index (`observed_at_ms` alone) serves the daily batched prune, which has no leading equality.
 *
 * Backfill: none. Nothing earlier is recoverable; history begins at the upgrade.
 */
export const ITEM_HISTORY_V94_SQL = [
  `CREATE TABLE IF NOT EXISTS item_history (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  service TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  observed_at_ms INTEGER NOT NULL,
  source_at_ms INTEGER
)`,
  "CREATE INDEX IF NOT EXISTS item_history_item ON item_history (item_id, observed_at_ms)",
  "CREATE INDEX IF NOT EXISTS item_history_type ON item_history (service, type, observed_at_ms)",
  "CREATE INDEX IF NOT EXISTS item_history_observed ON item_history (observed_at_ms)",
];
