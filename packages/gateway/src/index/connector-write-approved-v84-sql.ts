/**
 * V84 — the approved set of a model connector-write opt-in (Phase 9.7 Project B, re-consent).
 *
 * `connector_write_enablement.approved_tool_ids`: a JSON array (sorted) of the write-row tool ids
 * the owner's `connector.writes.enable` prompt listed as offerable when they approved it. The model
 * is offered a row only when its tool id is in this set, checked when the tools are listed AND again
 * on every call, so a write that becomes offerable later (a template lands) is not offered until
 * the owner re-enables and approves it by name.
 *
 * Backfill: none. Every opt-in written before this version gets `'[]'`, so it offers nothing until
 * the owner re-enables (fail closed); before V84 nothing was offerable, so nothing is lost.
 */
export const CONNECTOR_WRITE_APPROVED_V84_SQL = [
  `ALTER TABLE connector_write_enablement ADD COLUMN approved_tool_ids TEXT NOT NULL DEFAULT '[]'`,
] as const;
