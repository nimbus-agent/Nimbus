/**
 * V98 - `user_mcp_connector.write_paths_json`: the directories a user MCP server may WRITE beneath
 * (Phase 28 AD5b; invariant I15).
 *
 * A JSON array of canonical directory paths, at most four, approved by the local owner at
 * registration (`nimbus connector add --mcp ... --write <dir>`) and checked again at every spawn.
 * It lives on the server's own row because a grant belongs to exactly one registration and must
 * die with it: a registration has no update path (insert and delete only), so the value is written
 * once, by `insertUserMcpConnector`.
 *
 * Additive column, forward-only: `DEFAULT '[]'` is the correct backfill, so no server that exists
 * at this migration gains a grant. The runner guards the `ALTER` with a column probe so the step can
 * run twice (SQLite has no `ADD COLUMN IF NOT EXISTS`, and the suites rewind `user_version`).
 */
export const USER_MCP_WRITE_V98_SQL = `
ALTER TABLE user_mcp_connector ADD COLUMN write_paths_json TEXT NOT NULL DEFAULT '[]';
`;
