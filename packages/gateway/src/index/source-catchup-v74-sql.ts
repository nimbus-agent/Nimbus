/**
 * V74 — per-source catch-up cursors and `decision_record.scored_kind` (role packs P2, PR 2a).
 *
 * A source mapping can change while the gateway runs, so a type that was unmapped for a while holds
 * items nobody scanned. `source_catchup_state` is one cursor per (pass, service:type) so a type that
 * joins the mapping is caught up over its own unmapped window. No seed rows: built-ins are handled
 * in code. `idx_item_service_type_modified` serves the catch-up scan (one `service`/`type` pair,
 * ordered by `(modified_at, id)`): the item table's indexes are single-column, so without it each
 * batch read and sorted every item of that type.
 *
 * `scored_kind` records the kind a decision's priority was scored under, so a later re-kind does not
 * read as a stale scale. The backfill is a FROZEN literal of the 13 built-in keys as they stood when
 * V74 shipped (a later change to the built-in table must not alter what V74 wrote). Rows with no
 * item, or a non-built-in type, stay NULL. Additive only.
 */
export const SOURCE_CATCHUP_V74_SQL = `
CREATE TABLE IF NOT EXISTS source_catchup_state (
  pass         TEXT NOT NULL CHECK(pass IN ('decisions','glossary')),
  service_type TEXT NOT NULL,
  watermark_ms INTEGER NOT NULL DEFAULT 0,
  watermark_id TEXT NOT NULL DEFAULT '',
  done         INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  PRIMARY KEY (pass, service_type)
);
CREATE INDEX IF NOT EXISTS idx_item_service_type_modified
  ON item(service, type, modified_at, id);
ALTER TABLE decision_record ADD COLUMN scored_kind TEXT
  CHECK (scored_kind IS NULL OR scored_kind IN ('message','doc','ticket','commit','note'));
UPDATE decision_record SET scored_kind = (
  SELECT CASE (i.service || ':' || i.type)
    WHEN 'slack:message' THEN 'message'
    WHEN 'discord:message' THEN 'message'
    WHEN 'teams:message' THEN 'message'
    WHEN 'notion:page' THEN 'doc'
    WHEN 'confluence:page' THEN 'doc'
    WHEN 'obsidian:obsidian_note' THEN 'doc'
    WHEN 'linear:issue' THEN 'ticket'
    WHEN 'jira:issue' THEN 'ticket'
    WHEN 'github:issue' THEN 'ticket'
    WHEN 'gitlab:issue' THEN 'ticket'
    WHEN 'github:commit' THEN 'commit'
    WHEN 'gitlab:commit' THEN 'commit'
    WHEN 'filesystem:git_commit' THEN 'commit'
    ELSE NULL
  END
  FROM item i WHERE i.id = decision_record.source_item_id
);
`;
