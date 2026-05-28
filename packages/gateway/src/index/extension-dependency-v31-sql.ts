export const V31_EXTENSION_DEPENDENCY_SQL = `
CREATE TABLE extension_dependency (
  extension_id  TEXT    NOT NULL,
  depends_on_id TEXT    NOT NULL,
  range         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (extension_id, depends_on_id)
);

CREATE INDEX idx_extension_dependency_reverse
  ON extension_dependency (depends_on_id);
` as const;
