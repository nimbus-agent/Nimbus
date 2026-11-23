/**
 * V107 - long-term episodic memory (Phase 10, owner ruling OR-S4-MEM, invariant I61, static D52).
 *
 * `episodic_pending_turn`: one row per OWNER turn of a session that has not been summarised yet - the
 * owner's own message and the final assistant answer, nothing else (no tool output, no connector content,
 * no retrieved item, no text an MCP client sent). Deleted when the session is summarised, when the owner
 * forgets, and at retention. `episodic_memory`: one row per summarised session. `embedding` is a 384-float
 * little-endian BLOB made by the LOCAL embedder only (NULL when none was available); recall is a cosine scan in
 * `memory/episodic-store.ts`, so no sqlite-vec table is shared with the index (a shared KNN would be crowded
 * out by index chunks) and nothing is orphaned by a delete.
 *
 * NO foreign key and NO trigger. Written ONLY by `memory/episodic-store.ts` (static D52). Backfill: none.
 * Re-runnable (IF NOT EXISTS only).
 */
export const EPISODIC_MEMORY_V107_SQL = [
  `CREATE TABLE IF NOT EXISTS episodic_pending_turn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  owner_text    TEXT NOT NULL,
  answer_text   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS idx_episodic_pending_session ON episodic_pending_turn(session_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_episodic_pending_created ON episodic_pending_turn(created_at)",
  `CREATE TABLE IF NOT EXISTS episodic_memory (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  summary       TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  turn_count    INTEGER NOT NULL CHECK (turn_count >= 1),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  embedding     BLOB
)`,
  "CREATE INDEX IF NOT EXISTS idx_episodic_memory_created ON episodic_memory(created_at)",
];
