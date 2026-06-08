export const POLICY_V36_SQL = `
CREATE TABLE IF NOT EXISTS org_policy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  toml TEXT NOT NULL,
  sig TEXT NOT NULL,
  org TEXT NOT NULL,
  version INTEGER NOT NULL,
  issued_at TEXT,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_anchor_pin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pubkey TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  source TEXT NOT NULL
);
`;
