/**
 * V72 — the `item` write path and the hot read filters (code audit 2026-10-19, F3 + F5).
 *
 * **The FTS update trigger fires only when indexed text changed.** The V48 `item_fts_update`
 * trigger has no `OF <column>` list and no `WHEN`, so every upsert re-indexed up to 16 KiB of body
 * in `item_fts`, even when a sync re-wrote an item with identical text (the common case: a
 * connector re-pages a window and only `synced_at` moves). FTS5's external-content `'delete'`
 * command must be handed the values that were indexed, so skipping the pair is only correct when
 * neither indexed column changed, which is exactly the `WHEN` below. `IS NOT` rather than `!=` so a
 * NULL `body` on either side still compares.
 *
 * `ITEM_FTS_UPDATE_TRIGGER_SQL` (V48) is left as it was: the V52 backfill drops and recreates
 * THAT definition while it runs, and a database being upgraded passes through V52 before it
 * reaches this step, so this step always has the last word.
 *
 * **Composite indexes for the filters the agents and the read RPCs actually use**:
 * `service IN (…) AND type = ? AND modified_at BETWEEN …`, `type = ? AND modified_at …`, and
 * `author_id = ?` (which had no index at all, so `nimbus people` counted each person's items with a
 * full scan). The two single-column indexes they make redundant (`idx_item_service`,
 * `idx_item_type`, both left-prefixes of the new ones) are dropped so a write does not maintain
 * them twice. `idx_item_modified_at` stays: an unfiltered `ORDER BY modified_at` still uses it.
 *
 * **Person handle lookups** (`person-store.ts`'s `findPersonBy*`, one per synced author) were full
 * scans of `person`; each handle column gets a partial index over its non-NULL rows.
 *
 * **`watcher_event` by watcher**: `nimbus watcher history` reads one watcher's newest events, and
 * the table had no index but its primary key, so each read scanned every event of every watcher.
 *
 * No `ANALYZE` here: on a large index it would hold the upgrade for seconds, and the
 * `PRAGMA optimize` the gateway already runs at open and close gathers statistics for the new
 * indexes on its own.
 */
export const ITEM_FTS_UPDATE_TRIGGER_V72_SQL = `CREATE TRIGGER item_fts_update AFTER UPDATE OF title, body ON item
   WHEN old.title IS NOT new.title OR old.body IS NOT new.body
   BEGIN
     INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
     INSERT INTO item_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`;

/** The `person` columns that hold a per-service handle, each looked up by equality. */
export const PERSON_HANDLE_COLUMNS = [
  "github_login",
  "gitlab_login",
  "slack_handle",
  "linear_member_id",
  "jira_account_id",
  "notion_user_id",
  "bitbucket_uuid",
  "microsoft_user_id",
  "discord_user_id",
] as const;

export const ITEM_WRITE_PATH_V72_SQL: readonly string[] = [
  "DROP TRIGGER IF EXISTS item_fts_update",
  ITEM_FTS_UPDATE_TRIGGER_V72_SQL,
  "CREATE INDEX IF NOT EXISTS idx_item_service_type_modified ON item(service, type, modified_at)",
  "CREATE INDEX IF NOT EXISTS idx_item_type_modified ON item(type, modified_at)",
  "CREATE INDEX IF NOT EXISTS idx_item_author_modified ON item(author_id, modified_at)",
  "DROP INDEX IF EXISTS idx_item_service",
  "DROP INDEX IF EXISTS idx_item_type",
  "CREATE INDEX IF NOT EXISTS idx_watcher_event_watcher_fired ON watcher_event(watcher_id, fired_at)",
  ...PERSON_HANDLE_COLUMNS.map(
    (col) =>
      `CREATE INDEX IF NOT EXISTS idx_person_${col} ON person(${col}) WHERE ${col} IS NOT NULL`,
  ),
];
