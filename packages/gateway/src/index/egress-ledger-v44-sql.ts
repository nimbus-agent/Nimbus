/**
 * V44 (S1 "Local Brain" — provable-locality primitive) — `egress_ledger`: an always-on,
 * append-only, BLAKE3-chained ledger of every outbound action the gateway AUTHORIZES.
 *
 * `destination` is the service/host derived from the action-type prefix (`serviceOf()`), NEVER a
 * raw URL with a query-string secret. `payload_summary` is `redactAuditPayload(action.payload)`
 * capped at 256 bytes. `result_status='blocked'` rows record what was STOPPED (a denied gate).
 * `source_type='prune'` is the single tombstone row class (the only sanctioned mutation continues
 * the chain rather than leaving a silent gap). Append-only; manual prune only. See I29/D22.
 */
export const EGRESS_LEDGER_V44_SQL = `
CREATE TABLE IF NOT EXISTS egress_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        INTEGER NOT NULL,
  source_type      TEXT NOT NULL,
  source_id        TEXT,
  destination      TEXT NOT NULL,
  method           TEXT NOT NULL,
  payload_summary  TEXT NOT NULL,
  hitl_status      TEXT NOT NULL CHECK(hitl_status IN ('approved','not_required','rejected')),
  result_status    TEXT NOT NULL CHECK(result_status IN ('authorized','blocked')),
  row_hash         TEXT NOT NULL,
  prev_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_ts ON egress_ledger(timestamp);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_source ON egress_ledger(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_egress_ledger_dest ON egress_ledger(destination);
`;
