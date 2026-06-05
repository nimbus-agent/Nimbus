// V34 — Phase 6 Slice 3 (Identity & Access).
// Append-only: 4 new tables. No secret values are stored in any column (tokens live in the Vault).
export const V34_IDENTITY_SQL: readonly string[] = [
  `-- One current operator session per issuer (Nimbus is single-operator/local-first); re-login UPSERTs this row.
   CREATE TABLE IF NOT EXISTS identity_session (
     issuer        TEXT PRIMARY KEY,
     external_id   TEXT NOT NULL,
     email         TEXT,
     claims_json   TEXT NOT NULL DEFAULT '{}',
     validated_at  INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     status        TEXT NOT NULL DEFAULT 'active'
   );`,
  `CREATE TABLE IF NOT EXISTS scim_user (
     external_id   TEXT PRIMARY KEY,
     user_name     TEXT,            -- nullable by design: SCIM-layer enforced; allows partial provisioning before full sync
     email         TEXT,
     active        INTEGER NOT NULL DEFAULT 1,
     attrs_json    TEXT NOT NULL DEFAULT '{}',
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS identity_binding (
     external_id   TEXT NOT NULL,
     peer_id       TEXT NOT NULL,
     bound_at      INTEGER NOT NULL,
     bound_by      TEXT NOT NULL CHECK(bound_by IN ('handshake','admin')),
     revoked_at    INTEGER,
     PRIMARY KEY (external_id, peer_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_identity_binding_peer ON identity_binding(peer_id);`,
  `CREATE TABLE IF NOT EXISTS oidc_jwks_cache (
     issuer        TEXT NOT NULL,
     kid           TEXT NOT NULL,
     key_json      TEXT NOT NULL,
     fetched_at    INTEGER NOT NULL,
     PRIMARY KEY (issuer, kid)
   );`,
];
