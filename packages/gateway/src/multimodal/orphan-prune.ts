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
 *
 * `json_extract` RAISES on malformed JSON — it does not return NULL — and `COALESCE` does NOT
 * guard it: `COALESCE` only substitutes for a NULL RESULT, never for a thrown error, so a single
 * derived row whose `metadata` does not round-trip would abort the whole statement. That matters
 * more here than almost anywhere else in this subsystem: this sweep runs FIRST at pass start
 * (`pruneOrphanedMedia`, below, called from `media-pass.ts`), so one bad row here would abort the
 * ENTIRE pass before `media-discovery.ts`'s own `json_valid` guard ever got a chance to run. Both
 * `json_extract` calls below are wrapped in `CASE WHEN json_valid(...) THEN ... END`, the same
 * pattern `media-discovery.ts` uses, so an unparseable row reads as "no `derivedFrom`" — KEPT,
 * never deleted on a guess — rather than blowing up the sweep for every artifact.
 */
import type { Database } from "bun:sqlite";
import { dbStmtRun } from "../db/write.ts";
import { revokeOrphanedGrants } from "./media-grant-store.ts";

const UNDERSTANDING_TYPES = ["image_understanding", "video_understanding"] as const;

/** `CASE WHEN json_valid(...) THEN json_extract(...) END` — see the module doc above for why. */
function safeExtractDerivedFrom(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.derivedFrom') END`;
}

// The single definition of "orphaned understanding row", shared verbatim by the COUNT and the
// DELETE below. A second copy of this predicate is exactly the bug this module exists to avoid:
// two independent copies means one can drift from the other and the returned count silently stops
// matching the rows actually deleted. The `?` placeholders are bound at each call site with
// UNDERSTANDING_TYPES — I9-safe (see module doc above).
const ORPHANED_UNDERSTANDING_WHERE = `
  WHERE service = 'nimbus'
    AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
    AND ${safeExtractDerivedFrom("metadata")} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM item AS src
       WHERE src.id = ${safeExtractDerivedFrom("item.metadata")}
    )
`;

export function pruneOrphanedUnderstandings(db: Database): number {
  // Count orphaned understanding rows with the same WHERE predicate as the DELETE, then delete them.
  // Both statements run inside a transaction so nothing can change between count and delete.
  // Do NOT return result.changes: bun:sqlite's .changes includes trigger-cascaded rows, and item
  // carries FTS5 triggers that delete shadow-table rows on item deletion. Returning .changes would
  // count FTS bookkeeping as pruned understandings, not the actual orphans.
  return db.transaction(() => {
    const countStmt = db.query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) as n FROM item ${ORPHANED_UNDERSTANDING_WHERE}`,
    );
    const countRow = countStmt.get(...UNDERSTANDING_TYPES);
    if (countRow === null) {
      throw new Error("pruneOrphanedUnderstandings: COUNT(*) query returned no row");
    }
    const orphanCount = countRow.n;

    // dbStmtRun, never a bare .run() — invariant I14 / static rule D12. A raw call fails the
    // structure audit before the tests run, and skips the SQLITE_FULL -> disk-space-warning path.
    const deleteStmt = db.query(`DELETE FROM item ${ORPHANED_UNDERSTANDING_WHERE}`);
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
