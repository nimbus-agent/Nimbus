/**
 * V45 — glossary_term + glossary_pass_state (implicit-knowledge glossary).
 *
 * `glossary_term` is the SSoT for the extraction pass: it holds candidates in
 * every status, including `pending` work not yet consolidated and `vetoed`
 * rejections that must never be re-asked. Only `consolidated` rows are
 * projected into the searchable `item` table.
 *
 * `first_seen_at` / `last_seen_at` are CONTENT dates — the min/max
 * `item.modified_at` across citing items — not row timestamps. They are
 * recomputed, never stamped on insert.
 *
 * `stats_verified_at` drives the reconciliation sweep: terms are re-verified
 * round-robin oldest-first so that a term whose sources were deleted is
 * eventually demoted rather than lingering with inflated statistics.
 *
 * `attempts` / `last_attempt_at` prevent head-of-line blocking in the
 * consolidation queue. The queue is ordered by score, and a failed
 * consolidation leaves the row `pending` — so without a backoff the same
 * high-scoring failures would be re-selected every pass forever and no
 * lower-scoring term would ever consolidate. Some failures are PERMANENT
 * (e.g. in snippet mode, a term whose sources never state it in a full
 * sentence), so this is starvation by construction, not a rare race.
 *
 * `glossary_pass_state` carries a COMPOSITE scan cursor: `watermark_ms` alone
 * cannot express "resume inside a group of items sharing one `modified_at`".
 * A bulk import stamping thousands of rows with a single job-level timestamp
 * is ordinary, and a batch truncated inside such a group would otherwise
 * advance past it and skip the remainder permanently. `watermark_id` breaks
 * the tie using `item.id`, which is a primary key and therefore total.
 */
export const GLOSSARY_V45_SQL = `
CREATE TABLE IF NOT EXISTS glossary_term (
  term_key          TEXT PRIMARY KEY,
  display_term      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
  definition        TEXT,
  definition_source TEXT CHECK(definition_source IN ('llm','snippet')),
  doc_freq          INTEGER NOT NULL DEFAULT 0,
  service_spread    INTEGER NOT NULL DEFAULT 0,
  score             REAL    NOT NULL DEFAULT 0,
  form              TEXT    NOT NULL DEFAULT 'phrase',
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  top_sources       TEXT NOT NULL DEFAULT '[]',
  synonyms          TEXT NOT NULL DEFAULT '[]',
  near_misses       TEXT NOT NULL DEFAULT '[]',
  consolidated_at   INTEGER,
  stats_verified_at INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score
  ON glossary_term(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt
  ON glossary_term(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_glossary_term_display
  ON glossary_term(display_term);
CREATE INDEX IF NOT EXISTS idx_glossary_term_verified
  ON glossary_term(status, stats_verified_at);

CREATE TABLE IF NOT EXISTS glossary_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);
`;
