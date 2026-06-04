// V33 — Phase 6 Slice 1 (Federation Core).
// Append-only: 3 new tables + 1 nullable column on audit_log.
export const V33_FEDERATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS federation_namespaces (
     namespace_id TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     owner_self   INTEGER NOT NULL DEFAULT 1,
     created_at   INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS federation_namespace_filters (
     namespace_id TEXT NOT NULL,
     filter_kind  TEXT NOT NULL CHECK(filter_kind IN ('service','type','tag')),
     filter_value TEXT NOT NULL,
     PRIMARY KEY (namespace_id, filter_kind, filter_value)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_fed_filters_ns ON federation_namespace_filters(namespace_id);`,
  `CREATE TABLE IF NOT EXISTS federation_grants (
     namespace_id     TEXT NOT NULL,
     peer_id          TEXT NOT NULL,
     role             TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
     standing_consent INTEGER NOT NULL DEFAULT 0,
     granted_at       INTEGER NOT NULL,
     revoked_at       INTEGER,
     PRIMARY KEY (namespace_id, peer_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_fed_grants_peer ON federation_grants(peer_id);`,
  `ALTER TABLE audit_log ADD COLUMN federation_json TEXT;`,
];
