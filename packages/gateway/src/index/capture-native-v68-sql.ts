/**
 * V68 — capture-sink provenance (spec 2026-10-11 § 4.4, invariant I28, PR 2).
 *
 * `decision_record.extraction_source` and `glossary_term.definition_source` admit `'agent'`, and
 * both tables gain a nullable `capture_id`: the capture that currently OWNS the row, so revoke can
 * tell "my row" from one a later capture, a pass or a manual term took over. `NULL` on every
 * pass-written row. SQLite cannot widen a CHECK in place, so both tables are REBUILT (the V46
 * precedent), with every column named on both sides of the copy.
 *
 * `decision_record` is an FK PARENT (`decision_evidence … ON DELETE CASCADE`), unlike V46's table.
 * With `foreign_keys = ON`, `DROP TABLE decision_record` performs an implicit DELETE that cascades
 * the evidence away, and `PRAGMA foreign_keys` is a no-op inside the step's transaction, so it
 * cannot be switched off here. The evidence is therefore held aside and restored: a no-op restore
 * when the cascade did not fire (production migrates before `ensureSchema` turns FKs on), a full one
 * when it did. Evidence whose decision no longer exists (pre-existing orphans) is not restored.
 * The runner step counts the restore before the hold table is dropped (spec deviation: a count,
 * not `foreign_key_check`, so a pre-existing orphan cannot brick every boot).
 */
const DECISION_COLS = `id, source_item_id, status, statement, rationale, alternatives,
  extraction_source, cue_tier, cue_text, priority, confidence, decided_at, has_adr,
  stats_verified_at, attempts, last_attempt_at, updated_at`;

const EVIDENCE_COLS =
  "decision_id, kind, entity_id, item_id, evidence_key, label, url, occurred_at";

export const V68_EVIDENCE_HOLD = "decision_evidence_v68_hold";

/** Part 1: hold the evidence, rebuild decision_record, restore. The runner counts, then runs part 2. */
export const CAPTURE_NATIVE_V68_REBUILD_DECISIONS_SQL: readonly string[] = [
  `CREATE TABLE ${V68_EVIDENCE_HOLD} AS SELECT ${EVIDENCE_COLS} FROM decision_evidence`,
  `CREATE TABLE IF NOT EXISTS decision_record_v68 (
     id                TEXT PRIMARY KEY,
     source_item_id    TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
     statement         TEXT,
     rationale         TEXT,
     alternatives      TEXT NOT NULL DEFAULT '[]',
     extraction_source TEXT CHECK(extraction_source IN ('llm','snippet','agent')),
     cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
     cue_text          TEXT NOT NULL,
     priority          REAL NOT NULL DEFAULT 0,
     confidence        REAL NOT NULL DEFAULT 0,
     decided_at        INTEGER NOT NULL,
     has_adr           INTEGER NOT NULL DEFAULT 0,
     stats_verified_at INTEGER NOT NULL DEFAULT 0,
     attempts          INTEGER NOT NULL DEFAULT 0,
     last_attempt_at   INTEGER NOT NULL DEFAULT 0,
     updated_at        INTEGER NOT NULL,
     capture_id        TEXT
   )`,
  `INSERT INTO decision_record_v68 (${DECISION_COLS}) SELECT ${DECISION_COLS} FROM decision_record`,
  "DROP TABLE decision_record",
  "ALTER TABLE decision_record_v68 RENAME TO decision_record",
  "CREATE INDEX IF NOT EXISTS idx_decision_status_confidence ON decision_record(status, confidence DESC)",
  "CREATE INDEX IF NOT EXISTS idx_decision_pending_priority ON decision_record(status, priority DESC, last_attempt_at)",
  "CREATE INDEX IF NOT EXISTS idx_decision_decided_at ON decision_record(status, decided_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_decision_verified ON decision_record(status, stats_verified_at)",
  "CREATE INDEX IF NOT EXISTS idx_decision_source_item ON decision_record(source_item_id)",
  "DELETE FROM decision_evidence",
  `INSERT INTO decision_evidence (${EVIDENCE_COLS})
     SELECT ${EVIDENCE_COLS} FROM ${V68_EVIDENCE_HOLD}
      WHERE decision_id IN (SELECT id FROM decision_record)`,
];

/** Rows the restore MUST have produced (counted before the hold table is dropped). */
export const V68_EXPECTED_EVIDENCE_SQL = `SELECT COUNT(*) AS n FROM ${V68_EVIDENCE_HOLD}
  WHERE decision_id IN (SELECT id FROM decision_record)`;

const GLOSSARY_COLS = `term_key, display_term, status, definition, definition_source, doc_freq,
  service_spread, score, form, first_seen_at, last_seen_at, top_sources,
  synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
  last_attempt_at, updated_at`;

/** Part 2: drop the hold, rebuild glossary_term (no FK in either direction), seed relation types. */
export const CAPTURE_NATIVE_V68_FINISH_SQL: readonly string[] = [
  `DROP TABLE ${V68_EVIDENCE_HOLD}`,
  `CREATE TABLE IF NOT EXISTS glossary_term_v68 (
     term_key          TEXT PRIMARY KEY,
     display_term      TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
     definition        TEXT,
     definition_source TEXT CHECK(definition_source IN ('llm','snippet','manual','agent')),
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
     updated_at        INTEGER NOT NULL,
     capture_id        TEXT
   )`,
  `INSERT INTO glossary_term_v68 (${GLOSSARY_COLS}) SELECT ${GLOSSARY_COLS} FROM glossary_term`,
  "DROP TABLE glossary_term",
  "ALTER TABLE glossary_term_v68 RENAME TO glossary_term",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score ON glossary_term(status, score DESC)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt ON glossary_term(status, last_attempt_at)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_display ON glossary_term(display_term)",
  "CREATE INDEX IF NOT EXISTS idx_glossary_term_verified ON glossary_term(status, stats_verified_at)",
  // Prefixed so they can never coincide with a populator-written edge (spec § 4.4).
  `INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
     ('captured_relates_to', 1),
     ('captured_fixes', 1),
     ('captured_caused_by', 1),
     ('captured_supersedes', 1),
     ('captured_documents', 1)`,
];
