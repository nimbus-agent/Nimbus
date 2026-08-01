/**
 * V47 — decision_record + decision_evidence + decision_pass_state
 * (implicit ADR extractor, Spine S1).
 *
 * `decision_record.id` is content-derived: hash(source_item_id, normalized cue
 * sentence). It is deliberately NOT positional. Keying on the cue's character
 * offset would mean a typo fix earlier in a document re-hashes every later cue,
 * re-queueing extracted rows AND resurrecting `vetoed` ones under new ids —
 * which would defeat the whole reason this table has no foreign key.
 *
 * `source_item_id` carries NO foreign key on purpose. `vetoed` rows are the
 * durable record of model calls already spent; cascading them away on an index
 * reset would re-burn the extraction budget on candidates already rejected. The
 * reconciliation sweep demotes rows whose source is gone instead.
 * `decision_evidence` DOES cascade — it is derived, cheap to recompute, and
 * meaningless without its parent.
 *
 * `priority` and `confidence` are two different numbers on purpose. `priority`
 * is knowable before the model runs (cue strength + source authority) and
 * orders the extraction queue. `confidence` needs corroboration and
 * completeness, so it is 0 for every pending row and must never be used to
 * order that queue.
 *
 * `decided_at` is a CONTENT date — the source item's `modified_at` — never a
 * row timestamp.
 *
 * `decision_pass_state` carries a COMPOSITE cursor. `watermark_ms` alone cannot
 * express "resume inside a group of items sharing one `modified_at`", and a
 * bulk import stamping thousands of rows with one job-level timestamp makes
 * that ordinary. `watermark_id` breaks the tie on `item.id`, a primary key and
 * therefore total.
 */
export const DECISIONS_V47_SQL = `
CREATE TABLE IF NOT EXISTS decision_record (
  id                TEXT PRIMARY KEY,
  source_item_id    TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
  statement         TEXT,
  rationale         TEXT,
  alternatives      TEXT NOT NULL DEFAULT '[]',
  extraction_source TEXT CHECK(extraction_source IN ('llm','snippet')),
  cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
  cue_text          TEXT NOT NULL,
  priority          REAL NOT NULL DEFAULT 0,
  confidence        REAL NOT NULL DEFAULT 0,
  decided_at        INTEGER NOT NULL,
  has_adr           INTEGER NOT NULL DEFAULT 0,
  stats_verified_at INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_status_confidence
  ON decision_record(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_decision_pending_priority
  ON decision_record(status, priority DESC, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_decision_decided_at
  ON decision_record(status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_verified
  ON decision_record(status, stats_verified_at);
CREATE INDEX IF NOT EXISTS idx_decision_source_item
  ON decision_record(source_item_id);

CREATE TABLE IF NOT EXISTS decision_evidence (
  decision_id  TEXT NOT NULL REFERENCES decision_record(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK(kind IN ('source','pr','commit','migration','iac','adr')),
  entity_id    TEXT,
  item_id      TEXT,
  label        TEXT NOT NULL,
  url          TEXT,
  occurred_at  INTEGER,
  PRIMARY KEY (decision_id, kind, label)
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_decision
  ON decision_evidence(decision_id);

CREATE TABLE IF NOT EXISTS decision_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);
`;
