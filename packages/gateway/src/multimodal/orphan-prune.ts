/**
 * Deletes derived understanding rows whose source item has left the index (spec § 4.2).
 *
 * § 4.2 has claimed this behaviour since PR 1 and nothing implemented it: `derivedFrom` was
 * written and never read. Run at pass start rather than as a cascade in every delete path —
 * cheaper, and it self-heals rows orphaned before this shipped.
 *
 * A row whose `derivedFrom` is absent is KEPT. Treating a missing key as a missing source would
 * make a metadata-shape change delete every derived row at once.
 *
 * Bound-parameter free (no user input reaches this statement) and I9-safe: every identifier is a
 * literal in the source.
 */
import type { Database } from "bun:sqlite";
import { dbStmtRun } from "../db/write.ts";

const UNDERSTANDING_TYPES = ["image_understanding", "video_understanding"] as const;

export function pruneOrphanedUnderstandings(db: Database): number {
  // dbStmtRun, never a bare .run() — invariant I14 / static rule D12. A raw call fails the
  // structure audit before the tests run, and skips the SQLITE_FULL -> disk-space-warning path.
  const stmt = db.query(
    `DELETE FROM item
      WHERE service = 'nimbus'
        AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
        AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM item AS src
           WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
        )`,
  );
  const result = dbStmtRun(stmt, ...UNDERSTANDING_TYPES);
  return result.changes;
}
