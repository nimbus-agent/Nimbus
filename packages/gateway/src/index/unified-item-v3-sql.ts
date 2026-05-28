export const UNIFIED_ITEM_V3_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS person (
  id                TEXT PRIMARY KEY,
  display_name      TEXT,
  canonical_email   TEXT UNIQUE,
  github_login      TEXT,
  gitlab_login      TEXT,
  slack_handle      TEXT,
  linear_member_id  TEXT,
  jira_account_id   TEXT,
  notion_user_id    TEXT,
  metadata          TEXT,
  linked            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS item (
  id              TEXT PRIMARY KEY,
  service         TEXT NOT NULL,
  type            TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  title           TEXT NOT NULL,
  body_preview    TEXT,
  url             TEXT,
  canonical_url   TEXT,
  modified_at     INTEGER NOT NULL,
  author_id       TEXT,
  metadata        TEXT,
  synced_at       INTEGER NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(service, external_id)
);

CREATE INDEX IF NOT EXISTS idx_item_service ON item(service);
CREATE INDEX IF NOT EXISTS idx_item_type ON item(type);
CREATE INDEX IF NOT EXISTS idx_item_modified_at ON item(modified_at);

CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
  title,
  body_preview,
  content='item',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS item_fts_insert AFTER INSERT ON item BEGIN
  INSERT INTO item_fts(rowid, title, body_preview) VALUES (new.rowid, new.title, new.body_preview);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_delete AFTER DELETE ON item BEGIN
  INSERT INTO item_fts(item_fts, rowid, title, body_preview) VALUES ('delete', old.rowid, old.title, old.body_preview);
END;

CREATE TRIGGER IF NOT EXISTS item_fts_update AFTER UPDATE ON item BEGIN
  INSERT INTO item_fts(item_fts, rowid, title, body_preview) VALUES ('delete', old.rowid, old.title, old.body_preview);
  INSERT INTO item_fts(rowid, title, body_preview) VALUES (new.rowid, new.title, new.body_preview);
END;
`;

export const UNIFIED_ITEM_V3_MIGRATE_FROM_LEGACY_SQL = `
INSERT INTO item (
  id, service, type, external_id, title, body_preview, url, canonical_url,
  modified_at, author_id, metadata, synced_at, pinned
)
SELECT
  CASE
    WHEN substr(items.id, 1, length(items.service) + 1) = items.service || ':'
    THEN items.id
    ELSE items.service || ':' || items.id
  END,
  items.service,
  items.item_type,
  CASE
    WHEN substr(items.id, 1, length(items.service) + 1) = items.service || ':'
    THEN substr(items.id, length(items.service) + 2)
    ELSE items.id
  END,
  items.name,
  substr(items.name, 1, 512),
  items.url,
  NULL,
  COALESCE(items.modified_at, items.created_at, 0),
  NULL,
  json_object(
    'mime_type', items.mime_type,
    'size_bytes', items.size_bytes,
    'parent_id', items.parent_id,
    'legacy_raw_meta', items.raw_meta
  ),
  (strftime('%s', 'now') * 1000),
  0
FROM items;

DROP TRIGGER IF EXISTS items_fts_insert;
DROP TRIGGER IF EXISTS items_fts_delete;
DROP TRIGGER IF EXISTS items_fts_update;
DROP TABLE IF EXISTS items_fts;
DROP TABLE IF EXISTS items;
`;
