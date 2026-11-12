/**
 * V91 - my open work snapshots (Phase 10 MB1, morning-briefing spec § 5.0).
 *
 * `work_snapshot`: per (service, relation) the set of `item` rows that were the authenticated
 * user's open work the last time the provider was asked ("assigned to me", "review requested of
 * me", "my open pull requests"). Written only by `index/work-snapshot-store.ts` (static D24 rule
 * `work-snapshot-confined`), through the `replaceWorkSnapshot` sync capability. A snapshot member
 * is a pointer; the item itself lives in `item`.
 *
 * `item` is not a foreign-key parent here, so the `AFTER DELETE ON item` trigger is the cascade:
 * it covers `deleteItem` and the `DELETE FROM item WHERE service = ?` of a connector removal.
 * (An upsert is `ON CONFLICT DO UPDATE`, so a re-sync never fires it.)
 *
 * Backfill: none. No snapshot existed before this version.
 */
export const WORK_SNAPSHOT_V91_SQL = [
  `CREATE TABLE IF NOT EXISTS work_snapshot (
  service TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('assigned','review_requested','authored_open')),
  item_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (service, relation, item_id)
)`,
  "CREATE INDEX IF NOT EXISTS work_snapshot_item ON work_snapshot (item_id)",
  `CREATE TRIGGER IF NOT EXISTS work_snapshot_item_delete AFTER DELETE ON item
BEGIN
  DELETE FROM work_snapshot WHERE item_id = OLD.id;
END`,
];
