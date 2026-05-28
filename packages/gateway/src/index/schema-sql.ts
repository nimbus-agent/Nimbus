export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  service     TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime_type   TEXT,
  size_bytes  INTEGER,
  created_at  INTEGER,
  modified_at INTEGER,
  url         TEXT,
  parent_id   TEXT,
  raw_meta    TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name,
  content='items',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO items_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE INDEX IF NOT EXISTS idx_items_service       ON items(service);
CREATE INDEX IF NOT EXISTS idx_items_type          ON items(item_type);
CREATE INDEX IF NOT EXISTS idx_items_modified_at   ON items(modified_at);

CREATE TABLE IF NOT EXISTS sync_state (
  connector_id    TEXT PRIMARY KEY,
  last_sync_at    INTEGER,
  next_sync_token TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  hitl_status TEXT NOT NULL CHECK(hitl_status IN ('approved','rejected','not_required')),
  action_json TEXT NOT NULL,
  timestamp   INTEGER NOT NULL
);
`;
