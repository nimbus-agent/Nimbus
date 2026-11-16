/**
 * V99 - `capture.label_source`: where a proposer label came from (Phase 28 AD7a; D-AD-13).
 *
 * `declared` is the MCP client's own `clientInfo.name`; `kit` is the `--agent <kit>` value in the
 * server entry the owner (or `nimbus agent install`) wrote into the agent's configuration. Both are
 * what the connecting process says: neither is verified and neither decides anything. The column
 * exists so the approval prompt, the queue and the proof can say which of the two a label is.
 *
 * Additive column, forward-only: `DEFAULT 'declared'` is the correct backfill, since every label
 * stored before this step was a declared client name. The runner guards the `ALTER` with a column
 * probe so the step can run twice (SQLite has no `ADD COLUMN IF NOT EXISTS`, and the suites rewind
 * `user_version`).
 */
export const CAPTURE_LABEL_SOURCE_V99_SQL = `
ALTER TABLE capture ADD COLUMN label_source TEXT NOT NULL DEFAULT 'declared'
  CHECK (label_source IN ('declared', 'kit'));
`;
