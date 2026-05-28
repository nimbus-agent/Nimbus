export const LAN_PEERS_V19_SQL = `
CREATE TABLE IF NOT EXISTS lan_peers (
  peer_id       TEXT PRIMARY KEY,
  peer_pubkey   BLOB NOT NULL UNIQUE,
  direction     TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  host_ip       TEXT,
  host_port     INTEGER,
  display_name  TEXT,
  write_allowed INTEGER NOT NULL DEFAULT 0,
  paired_at     TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_lan_peers_direction ON lan_peers(direction);
CREATE INDEX IF NOT EXISTS idx_lan_peers_pubkey    ON lan_peers(peer_pubkey);
`;
