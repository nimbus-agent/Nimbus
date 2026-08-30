/**
 * V57 — computer-use session envelopes and their action stream (spec § 8.3).
 *
 * TWO tables with a deliberate split of duty against `audit_log`: the DECISIONS (what was approved,
 * what happened) ride the chained `audit_log` as `computer.action` rows and are PERMANENT; these
 * tables carry the REPLAY BODY, which is bulky and ages out (§ 8.4). That mirrors I33's split
 * between the code body it records in full and the output it records as digests.
 *
 * `observed_target` and `model_description` are separate columns on purpose. `observed_target` is
 * what the classifier read — a fact the gateway derived. `model_description` is what the model
 * SAID it was doing — attacker-influenceable, recorded for forensics, never an input to any
 * decision (I35). Collapsing them would destroy the one distinction the whole design turns on,
 * inside the record an incident responder reads.
 *
 * `dom_before` / `dom_after` are NULLed by retention past `snapshot_retention_days`; the audit row
 * survives. `dom_truncated` + `dom_original_bytes` exist so a clipped snapshot can never be
 * mistaken for a complete one — the same `truncated` convention `exec` already uses.
 *
 * NO screenshot column of any kind, on purpose: pixels are never persisted (§ 7). Only
 * `screenshot_digest`.
 *
 * The `lane` CHECK carries all three lanes even though only `browser` ships in slice 1. The column
 * is permanent in the data and widening a CHECK later is a table rebuild; the value set is known
 * now, so it lands complete — the same reasoning that froze `EGRESS_SOURCE_TYPES` complete.
 */
export const COMPUTER_USE_V57_SQL = `
CREATE TABLE IF NOT EXISTS cu_session (
  id             TEXT PRIMARY KEY,
  lane           TEXT NOT NULL CHECK(lane IN ('browser','terminal','screen')),
  envelope_json  TEXT NOT NULL,
  opened_at      INTEGER NOT NULL,
  closed_at      INTEGER,
  close_reason   TEXT,
  tainted_at     INTEGER,
  actions_used   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cu_action (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES cu_session(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  classification     TEXT NOT NULL CHECK(classification IN ('observing','actuating')),
  observed_target    TEXT NOT NULL,
  model_description  TEXT,
  hitl_status        TEXT NOT NULL,
  outcome            TEXT NOT NULL,
  dom_before         TEXT,
  dom_after          TEXT,
  dom_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(dom_truncated IN (0, 1)),
  dom_original_bytes INTEGER,
  screenshot_digest  TEXT,
  timestamp          INTEGER NOT NULL,
  UNIQUE (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cu_action_session ON cu_action(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_cu_action_time ON cu_action(timestamp);
`;
