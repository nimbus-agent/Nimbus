/**
 * V38 — asker-side cache of remote namespaces this gateway has successfully queried, so the
 * cross-colleague agents (ghost / conflicts / huddle) can default to an ambient fan-out without a
 * namespace-discovery primitive. Append-only; rows key on the stable peer_id.
 */
export const KNOWN_NAMESPACES_V38_SQL = `
CREATE TABLE IF NOT EXISTS federation_known_namespaces (
  peer_id       TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  PRIMARY KEY (peer_id, namespace)
);
`;
