/**
 * V56 — `sync_state.configured`: has this connector's credential ever been stored?
 *
 * Answers a question `health_state` structurally could not. That column carries a column-level
 * `CHECK` pinned to six values (`connector-health-v13-sql.ts`), and SQLite cannot widen a CHECK
 * without rebuilding the table — a drop-and-rename of the scheduler's core table, holding live
 * cursors and intervals, which this repo's append-only migration rule forbids and which is not
 * worth the risk for a reporting fix. A new column is purely additive and says the same thing.
 *
 * The two columns stay deliberately separate rather than one merged enum:
 *   - `health_state` — how the last REAL attempt went. Untouched, same six values.
 *   - `configured`   — whether there was ever a credential to attempt with.
 * `buildSnapshot` derives the single `not_configured` state consumers see, so nothing downstream
 * has to know there are two columns.
 *
 * DEFAULT 1 is the correct backfill, not a convenience: every existing row was written by a
 * connector that actually ran, and rows are only created for connectors the scheduler registered
 * and attempted. Defaulting to 0 would mark every working connector on every installed machine
 * as unconfigured on upgrade.
 */
export const CONNECTOR_CONFIGURED_V56_SQL = `
ALTER TABLE sync_state ADD COLUMN configured INTEGER NOT NULL DEFAULT 1;
`;
