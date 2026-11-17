/**
 * V102 - incident remediation proposals and the engine's small state (Phase 10 IC5a, incident-engine spec
 * § 5.5).
 *
 * `incident_proposal`: one row per remediation the engine PROPOSED for an incident record. `input_json` is
 * the exact tool input the action is built from (never caller text), `evidence_json` the item ids, rules and
 * confidence terms behind it. `status` moves `proposed` to `executing` to `executed`, `failed` or `denied`, or
 * from `proposed` to `expired` / `superseded`; every move is one `UPDATE ... WHERE id = ? AND status = ?`.
 * `action_id` is minted at the claim and is what `nimbus incident undo` takes. `captured_json` holds the
 * before-state values the row's inverse needs (never shown to the model or the owner as prompt text);
 * `undo_status` is the same single-step lifecycle for an undo (`undoing`, then `undone`; a declined or failed undo goes back to NULL so it can be retried).
 *
 * `incident_engine_state`: key/value rows of the engine's own switches (`advisory`: `on` or `off`).
 *
 * NO foreign key to `incident_record`, by design: a pruned record must not erase the fact that Nimbus acted.
 * An owner erasure deletes the proposals of the records it erases (`incident/incident-erasure.ts`). Written
 * ONLY by `incident/proposal-store.ts` (static D46(c)). Backfill: none. Re-runnable (IF NOT EXISTS only).
 */
export const INCIDENT_PROPOSAL_V102_SQL = [
  `CREATE TABLE IF NOT EXISTS incident_proposal (
  id              TEXT PRIMARY KEY,
  record_id       TEXT NOT NULL,
  record_version  INTEGER NOT NULL CHECK (record_version >= 1),
  kind            TEXT NOT NULL,
  tool_id         TEXT NOT NULL,
  input_json      TEXT NOT NULL CHECK (length(CAST(input_json AS BLOB)) <= 8192),
  evidence_json   TEXT NOT NULL CHECK (length(CAST(evidence_json AS BLOB)) <= 16384),
  confidence      INTEGER CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  reversibility   TEXT NOT NULL CHECK (reversibility IN ('reversible', 'irreversible', 'unknown')),
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'executing', 'executed', 'failed', 'denied', 'expired', 'superseded')),
  created_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  action_id       TEXT UNIQUE,
  captured_json   TEXT CHECK (captured_json IS NULL OR length(CAST(captured_json AS BLOB)) <= 4096),
  undo_status     TEXT CHECK (undo_status IS NULL OR undo_status IN ('undoing', 'undone')),
  undone_at_ms    INTEGER
)`,
  "CREATE INDEX IF NOT EXISTS incident_proposal_record ON incident_proposal (record_id, status, id)",
  `CREATE TABLE IF NOT EXISTS incident_engine_state (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at_ms   INTEGER NOT NULL
)`,
];
