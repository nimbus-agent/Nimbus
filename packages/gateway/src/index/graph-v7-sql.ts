export const GRAPH_V7_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS graph_entity (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  external_id TEXT NOT NULL,
  label       TEXT NOT NULL,
  service     TEXT,
  metadata    TEXT,
  UNIQUE(type, external_id)
);

CREATE TABLE IF NOT EXISTS graph_relation_type (
  name        TEXT PRIMARY KEY,
  directed    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS graph_relation (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL REFERENCES graph_entity(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES graph_entity(id) ON DELETE CASCADE,
  type        TEXT NOT NULL REFERENCES graph_relation_type(name),
  weight      REAL NOT NULL DEFAULT 1.0,
  metadata    TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_graph_relation_from ON graph_relation(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_relation_to ON graph_relation(to_id);

INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('authored', 1),
  ('reviewed', 1),
  ('targets', 1),
  ('resolves', 1),
  ('opened', 1),
  ('assigned', 1),
  ('belongs_to', 1),
  ('triggers', 1),
  ('tests', 1),
  ('affects', 1),
  ('fires_on', 1),
  ('correlates_with', 1),
  ('posted', 1),
  ('mentions', 1);
`;
