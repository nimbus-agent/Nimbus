export const EXTENSION_SESSION_V10_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS extension (
  id              TEXT PRIMARY KEY,
  version         TEXT NOT NULL,
  install_path    TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL,
  entry_hash      TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  installed_at    INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  vec_rowid     INTEGER NOT NULL,
  role          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_memory_session ON session_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_created ON session_memory(created_at);

CREATE TRIGGER IF NOT EXISTS session_memory_ad_delete_vec384
AFTER DELETE ON session_memory
FOR EACH ROW
BEGIN
  DELETE FROM vec_items_384 WHERE rowid = OLD.vec_rowid;
END;
`;

export const EXTENSION_SESSION_V10_NO_VEC_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS extension (
  id              TEXT PRIMARY KEY,
  version         TEXT NOT NULL,
  install_path    TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL,
  entry_hash      TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  installed_at    INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  vec_rowid     INTEGER,
  role          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_memory_session ON session_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_created ON session_memory(created_at);
`;
