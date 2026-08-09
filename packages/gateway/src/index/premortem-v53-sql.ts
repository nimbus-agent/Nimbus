/**
 * V53 — pre-mortem theme extraction (Spine S1).
 *
 * `premortem_theme.id` is CONTENT-DERIVED = hash(service, normalized label), never positional.
 * A positional key would re-hash every later theme when text earlier in a document changes,
 * orphaning accumulated evidence rows and re-spending the extraction budget on a theme already
 * mined.
 *
 * `premortem_pass_state` carries a COMPOSITE cursor for the same reason `decision_pass_state`
 * does: `watermark_ms` alone cannot express "resume inside a group of items sharing one
 * `modified_at`", and a bulk import stamping thousands of rows with one job-level timestamp makes
 * that ordinary. `watermark_id` breaks the tie on `item.id`, a primary key and therefore total.
 *
 * `premortem_watcher_proposal` is written by PR B, not by the pass — the table lands here because
 * schema precedes its reader. It records every watcher id pre-mortem has proposed, so an id
 * present here but ABSENT from `watcher` is one the user deleted deliberately and must never be
 * re-created.
 */
export const PREMORTEM_V53_SQL = `
CREATE TABLE IF NOT EXISTS premortem_theme (
  id            TEXT PRIMARY KEY,
  service       TEXT NOT NULL,
  label         TEXT NOT NULL,
  normalized    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('extracted','demoted')),
  confidence    REAL NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_premortem_theme_service_norm
  ON premortem_theme(service, normalized);
CREATE INDEX IF NOT EXISTS idx_premortem_theme_service_status
  ON premortem_theme(service, status, confidence DESC);

CREATE TABLE IF NOT EXISTS premortem_theme_evidence (
  theme_id     TEXT NOT NULL REFERENCES premortem_theme(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  label        TEXT NOT NULL,
  url          TEXT,
  occurred_at  INTEGER,
  PRIMARY KEY (theme_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS idx_premortem_evidence_theme
  ON premortem_theme_evidence(theme_id);
CREATE INDEX IF NOT EXISTS idx_premortem_evidence_item
  ON premortem_theme_evidence(item_id);

CREATE TABLE IF NOT EXISTS premortem_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO premortem_pass_state (id, watermark_ms, watermark_id) VALUES (1, 0, '');

CREATE TABLE IF NOT EXISTS premortem_watcher_proposal (
  watcher_id  TEXT PRIMARY KEY,
  epic_item_id TEXT NOT NULL,
  risk_kind   TEXT NOT NULL,
  service     TEXT NOT NULL,
  proposed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_premortem_proposal_epic
  ON premortem_watcher_proposal(epic_item_id);
`;
