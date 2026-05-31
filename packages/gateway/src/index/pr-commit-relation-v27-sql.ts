export const PR_COMMIT_RELATION_V27_SEED_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('merged_as', 1);
`;
