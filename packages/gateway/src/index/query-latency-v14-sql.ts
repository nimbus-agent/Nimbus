export const QUERY_LATENCY_V14_SQL = `
CREATE TABLE IF NOT EXISTS query_latency_log (
  id INTEGER PRIMARY KEY,
  latency_ms REAL NOT NULL,
  query_type TEXT NOT NULL CHECK(query_type IN ('fts','vector','hybrid','sql')),
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS slow_query_log (
  id INTEGER PRIMARY KEY,
  query_text TEXT,
  latency_ms REAL NOT NULL,
  query_type TEXT NOT NULL CHECK(query_type IN ('fts','vector','hybrid','sql')),
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_query_latency_recorded ON query_latency_log(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_query_recorded ON slow_query_log(recorded_at DESC);
`;
