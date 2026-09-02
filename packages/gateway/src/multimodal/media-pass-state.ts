/**
 * V58 cursor persistence (spec § 6.2).
 *
 * SQLite-backed rather than in-memory so an interrupted pass resumes across a gateway restart —
 * the whole point of a budgeted pass over a large library.
 *
 * Bound parameters only (I9).
 */
import type { Database } from "bun:sqlite";

export function readCursor(db: Database, passId: string): string | null {
  const row = db
    .query<{ last_item_id: string }, [string]>(
      "SELECT last_item_id FROM media_pass_cursor WHERE pass_id = ?",
    )
    .get(passId);
  return row?.last_item_id ?? null;
}

export function writeCursor(
  db: Database,
  passId: string,
  opts: { lastItemId: string; processedCount: number; nowMs: number },
): void {
  db.run(
    `INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at)
     VALUES (?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(pass_id) DO UPDATE SET
       last_item_id = excluded.last_item_id,
       processed_count = excluded.processed_count,
       updated_at = excluded.updated_at`,
    [passId, opts.lastItemId, opts.processedCount, opts.nowMs],
  );
}

export function clearCursor(db: Database, passId: string): void {
  db.run("DELETE FROM media_pass_cursor WHERE pass_id = ?", [passId]);
}
