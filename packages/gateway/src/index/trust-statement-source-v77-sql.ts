/**
 * V77 — every source a trust statement arrived from (marketplace trust layer, PR 3b).
 *
 * `trust_statement` keeps ONE row per statement id with its first source. A publisher-signed
 * statement is scoped to the registry whose index carried it (a hostile third-party registry must
 * not block, or give continuity to, extensions installed from elsewhere), while the same statement
 * in the Nimbus trust feed or its snapshot applies everywhere. The same statement can legitimately
 * arrive from several registries, and each must count, so the sources live in their own table, one
 * row per (statement, source). Named only by the trust store and this file (static rule D37).
 *
 * Backfill: each existing statement's first source, from `trust_statement.source` (a table capped by
 * the store's admission rules, so one statement suffices).
 */
export const TRUST_STATEMENT_SOURCE_V77_SQL = [
  `CREATE TABLE IF NOT EXISTS trust_statement_source (
     statement_id  TEXT NOT NULL,
     source        TEXT NOT NULL
       CHECK (source IN ('feed', 'snapshot') OR source LIKE 'registry:_%'),
     first_seen_at INTEGER NOT NULL,
     PRIMARY KEY (statement_id, source)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trust_statement_source_source
     ON trust_statement_source(source)`,
  `INSERT OR IGNORE INTO trust_statement_source (statement_id, source, first_seen_at)
     SELECT statement_id, source, first_seen_at FROM trust_statement
      WHERE kind <> 'publisher.verified'`,
] as const;
