/**
 * V65 — owner-approved grants for user MCP servers (spec 2026-10-06 § B). Defaults keep every
 * existing row at today's deny-all behaviour; `model_access` is stored now and read by PR 2.
 */
export const USER_MCP_GRANTS_V65_SQL = [
  `ALTER TABLE user_mcp_connector ADD COLUMN read_paths_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE user_mcp_connector ADD COLUMN net_hosts_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE user_mcp_connector ADD COLUMN model_access INTEGER NOT NULL DEFAULT 0`,
] as const;
