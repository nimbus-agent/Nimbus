/**
 * V61 — saved (persisted) generated tools, spec § 4.
 *
 * The row governs EXISTENCE; disk plus signature governs CONTENT. A `saved/<toolId>` directory with
 * no row here is an orphan and is swept at boot — never adopted — because a valid signature proves
 * an artifact was approved ONCE, not that it is approved NOW.
 *
 * `artifact_json` is the canonical byte string that was signed, stored verbatim so verification
 * never re-canonicalises. `pubkey` is per row so a Vault rotation reports as `pubkey_rotated`
 * rather than masquerading as tampering.
 */
export const GENERATED_TOOL_V61_SQL = `
CREATE TABLE IF NOT EXISTS generated_tool (
  tool_id          TEXT PRIMARY KEY,
  tool_name        TEXT NOT NULL,
  description      TEXT NOT NULL,
  artifact_json    TEXT NOT NULL,
  artifact_digest  TEXT NOT NULL,
  signature        TEXT NOT NULL,
  pubkey           TEXT NOT NULL,
  approved_at      INTEGER NOT NULL,
  saved_at         INTEGER NOT NULL,
  last_loaded_at   INTEGER,
  disabled_reason  TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_generated_tool_healthy
  ON generated_tool (tool_id) WHERE disabled_reason IS NULL;
`;
