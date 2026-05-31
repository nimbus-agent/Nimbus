export const USER_MCP_V11_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS user_mcp_connector (
  service_id  TEXT PRIMARY KEY,
  command     TEXT NOT NULL,
  args_json   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`;
