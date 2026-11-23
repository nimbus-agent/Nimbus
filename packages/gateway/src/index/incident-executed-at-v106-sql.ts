/**
 * V106 - `incident_proposal.executed_at_ms`, the stable time an action finished running (the incident
 * engine, `nimbus incident undo` with no id).
 *
 * V102's `updated_at_ms` moves on every later touch (a re-listing, an undo claim), so it cannot answer "which
 * reversible action ran most recently". `executed_at_ms` is set once, by `finishProposal` when a claimed
 * proposal becomes `executed`, and never changed after. Nullable: a proposal that never ran, and an executed
 * row from before V106 that was already undone, have none. The backfill gives an executed row with no undo the
 * time of its last update, which is its run's end.
 *
 * Written ONLY by `incident/proposal-store.ts` (static D46(c)). The `ALTER` is guarded by a column probe in the
 * step (`migrations/column-steps.ts`); the backfill only touches rows where the column is still NULL, so it is
 * re-runnable.
 */
export const INCIDENT_EXECUTED_AT_V106_SQL = [
  "ALTER TABLE incident_proposal ADD COLUMN executed_at_ms INTEGER",
  `UPDATE incident_proposal SET executed_at_ms = updated_at_ms
    WHERE status = 'executed' AND undo_status IS NULL AND executed_at_ms IS NULL`,
];
