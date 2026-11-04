/**
 * V83 — the owner's opt-in for model connector writes (Phase 9.7, S4).
 *
 * `connector_write_enablement`: one row per connector service the owner enabled for the model, with
 * the widest migration wave offered (`max_wave`: 2, 3 or 4). Absent row = no write of that service
 * is offered to the model (the default for every connector). Written only through the HITL-gated
 * `connector.writes.enable` handler; removing a row only narrows.
 *
 * Backfill: none. Nothing was enabled before this version.
 */
export const CONNECTOR_WRITE_ENABLEMENT_V83_SQL = [
  `CREATE TABLE IF NOT EXISTS connector_write_enablement (
  service TEXT PRIMARY KEY,
  max_wave INTEGER NOT NULL CHECK (max_wave IN (2, 3, 4)),
  enabled_at INTEGER NOT NULL
)`,
] as const;
