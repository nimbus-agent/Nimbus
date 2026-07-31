/**
 * V46 — widen `glossary_term.definition_source` to allow `'manual'`.
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
 * V45 shipped in v1.13.0, so editing `glossary-v45-sql.ts` is not available:
 * a fresh database runs V45 and then immediately rebuilds it here. Slightly
 * wasteful on an empty table, and correct.
 *
 * Columns are named explicitly rather than `INSERT … SELECT *`. The orders
 * match today, but a positional copy would silently misalign if V45's column
 * list were ever reordered — and a misaligned copy of a definition into a
 * score column is exactly the kind of corruption a migration must not risk.
 *
 * `DROP TABLE` drops the table's indexes with it, which is why all four are
 * recreated after the rename. No foreign key references `glossary_term` in
 * either direction, so the rebuild has no cascade.
 */
export const GLOSSARY_MANUAL_V46_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS glossary_term_v46 (
     term_key          TEXT PRIMARY KEY,
     display_term      TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
     definition        TEXT,
     definition_source TEXT CHECK(definition_source IN ('llm','snippet','manual')),
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
   )`,
  `INSERT INTO glossary_term_v46 (
     term_key, display_term, status, definition, definition_source, doc_freq,
     service_spread, score, form, first_seen_at, last_seen_at, top_sources,
     synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
     last_attempt_at, updated_at
   )
   SELECT
     term_key, display_term, status, definition, definition_source, doc_freq,
     service_spread, score, form, first_seen_at, last_seen_at, top_sources,
     synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
     last_attempt_at, updated_at
   FROM glossary_term`,
  "DROP TABLE glossary_term",
  "ALTER TABLE glossary_term_v46 RENAME TO glossary_term",
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score
     ON glossary_term(status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt
     ON glossary_term(status, last_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_display
     ON glossary_term(display_term)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_verified
     ON glossary_term(status, stats_verified_at)`,
];
