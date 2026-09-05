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
 * I9-safe: every identifier is a literal in the source, and the two values that ARE bound
 * (`UNDERSTANDING_TYPES`) are internal constants from this module, not caller input — the statement
 * takes no argument from anywhere outside it. Bound rather than interpolated even so: an internal
 * literal spliced into SQL is one refactor away from a caller-supplied one, and the `?` costs
 * nothing.
 */
import type { Database } from "bun:sqlite";
import { dbStmtRun } from "../db/write.ts";
import { revokeOrphanedGrants } from "./media-grant-store.ts";

const UNDERSTANDING_TYPES = ["image_understanding", "video_understanding"] as const;

export function pruneOrphanedUnderstandings(db: Database): number {
  // Count orphaned understanding rows with the same WHERE predicate as the DELETE, then delete them.
  // Both statements run inside a transaction so nothing can change between count and delete.
  // Do NOT return result.changes: bun:sqlite's .changes includes trigger-cascaded rows, and item
  // carries FTS5 triggers that delete shadow-table rows on item deletion. Returning .changes would
  // count FTS bookkeeping as pruned understandings, not the actual orphans.
  return db.transaction(() => {
    const countStmt = db.query(
      `SELECT COUNT(*) as n FROM item
        WHERE service = 'nimbus'
          AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
          AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM item AS src
             WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
          )`,
    );
    const orphanCount = (countStmt.get(...UNDERSTANDING_TYPES) as { n: number }).n;

    // dbStmtRun, never a bare .run() — invariant I14 / static rule D12. A raw call fails the
    // structure audit before the tests run, and skips the SQLITE_FULL -> disk-space-warning path.
    const deleteStmt = db.query(
      `DELETE FROM item
        WHERE service = 'nimbus'
          AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
          AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM item AS src
             WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
          )`,
    );
    dbStmtRun(deleteStmt, ...UNDERSTANDING_TYPES);
    return orphanCount;
  })();
}

/**
 * Both orphan sweeps, run together at pass start (spec § 19.7).
 *
 * One function rather than two calls at the call site so a future third derived artifact cannot be
 * added to one sweep and forgotten in the other — the same reason the egress exclusion list lives
 * inside `recordSyncEgress` rather than at each of its four call sites.
 */
export function pruneOrphanedMedia(
  db: Database,
  nowMs: number,
): { understandings: number; grants: number } {
  return {
    understandings: pruneOrphanedUnderstandings(db),
    grants: revokeOrphanedGrants(db, nowMs),
  };
}
