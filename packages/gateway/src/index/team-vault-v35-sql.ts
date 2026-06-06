// V35 — Phase 6 Slice 2 (Team Vault + Multi-user/Quorum HITL).
// Append-only: 3 new tables. Secret bytes live in the OS Vault under teamvault.<entry>.<key>,
// NEVER in these tables (metadata + RBAC only). Quorum/delegation in-flight state is session-only.
export const V35_TEAM_VAULT_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS team_vault_entries (
     entry      TEXT PRIMARY KEY,
     service    TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS team_vault_grants (
     entry      TEXT NOT NULL,
     peer_id    TEXT NOT NULL,
     tool_id    TEXT NOT NULL,
     mode       TEXT NOT NULL CHECK(mode IN ('use')),
     granted_at INTEGER NOT NULL,
     revoked_at INTEGER,
     PRIMARY KEY (entry, peer_id, tool_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_tv_grants_peer ON team_vault_grants(peer_id);`,
  `CREATE TABLE IF NOT EXISTS hitl_delegations (
     delegation_id TEXT PRIMARY KEY,
     delegate_peer TEXT NOT NULL,
     scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('action_type','service')),
     scope_value   TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     revoked_at    INTEGER
   );`,
  `CREATE INDEX IF NOT EXISTS idx_hitl_deleg_peer ON hitl_delegations(delegate_peer);`,
];
