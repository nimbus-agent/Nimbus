/**
 * V48 — `item.body` (up to 16 KiB for prose types) + `item.body_complete`,
 * with `item_fts` re-pointed from `body_preview` to `body`.
 *
 * `UPDATE item SET body = body_preview` runs BEFORE the rebuild and is
 * load-bearing: FTS5 external-content tables pull columns by name from the
 * content table, so rebuilding against a still-NULL `body` would silently
 * reduce every existing row's keyword coverage to its title alone. Seeding it
 * first makes the upgrade strictly non-regressive.
 *
 * `body_complete` deliberately stays 0 for every migrated row. It is a claim a
 * connector makes about the fetch it performed, and cannot be inferred from the
 * stored artefact — a body under 512 characters may be a Notion page that was
 * never fetched at all (`bodyPreview: ""`) or Gmail's ~200-character API
 * snippet, neither of which is complete.
 *
 * Do NOT "optimise" this to
 * `body_complete = CASE WHEN length(body_preview) < 512 THEN 1 ELSE 0 END`.
 * It has been proposed twice and rejected twice; the full reasoning is in the
 * spec under "Rejected: inferring completeness from length at migration time".
 * Length 0 would flag every title-only Notion and Confluence page as complete
 * and exclude the worst-covered connectors in the index from backfill forever.
 */
/**
 * The `item_fts_update` trigger definition, factored out as its own constant so the V52
 * resolve-key backfill (`index/migrations/runner.ts`) can DROP it for the duration of a
 * non-FTS backfill and recreate it from this SAME string afterwards — never a hand-retyped
 * copy that could drift from the schema's own trigger.
 */
export const ITEM_FTS_UPDATE_TRIGGER_SQL = `CREATE TRIGGER item_fts_update AFTER UPDATE ON item BEGIN
     INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
     INSERT INTO item_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`;

export const BODY_STORE_V48_SQL: readonly string[] = [
  "ALTER TABLE item ADD COLUMN body TEXT",
  "ALTER TABLE item ADD COLUMN body_complete INTEGER NOT NULL DEFAULT 0",
  "UPDATE item SET body = body_preview",
  "DROP TRIGGER IF EXISTS item_fts_insert",
  "DROP TRIGGER IF EXISTS item_fts_delete",
  "DROP TRIGGER IF EXISTS item_fts_update",
  "DROP TABLE IF EXISTS item_fts",
  `CREATE VIRTUAL TABLE item_fts USING fts5(
     title,
     body,
     content='item',
     content_rowid='rowid'
   )`,
  "INSERT INTO item_fts(item_fts) VALUES('rebuild')",
  `CREATE TRIGGER item_fts_insert AFTER INSERT ON item BEGIN
     INSERT INTO item_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
   END`,
  `CREATE TRIGGER item_fts_delete AFTER DELETE ON item BEGIN
     INSERT INTO item_fts(item_fts, rowid, title, body)
       VALUES ('delete', old.rowid, old.title, old.body);
   END`,
  ITEM_FTS_UPDATE_TRIGGER_SQL,
];
