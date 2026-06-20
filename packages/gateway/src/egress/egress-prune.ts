import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { appendEgressEntry } from "./egress-ledger.ts";

/**
 * Tombstone-boundary prune — the ONLY sanctioned mutation of the egress ledger.
 *
 * Deletes rows with `timestamp < beforeTs` in a SINGLE ATOMIC TRANSACTION (crash-safe:
 * either fully committed or fully rolled back). Surviving rows keep their ORIGINAL
 * `prev_hash` / `row_hash` — their write-time hashes are NEVER modified — so all prior
 * signed proofs over those rows remain valid and a prune is cryptographically distinguishable
 * from a history rewrite.
 *
 * After deletion a single `source_type='prune'` tombstone is appended whose `source_id`
 * carries `boundaryHash` (the `prev_hash` of the first surviving row, or — for a full prune —
 * the `row_hash` of the last deleted row by monotonic id). `source_id` is part of
 * `computeEgressRowHash`, so the attestation is tamper-evident. `verifyEgressChain` accepts
 * the attested boundary as a legitimate chain start for the surviving segment.
 *
 * Sequential multi-prune correctness: a prior tombstone row is appended AFTER the regular rows
 * of its era, so it has a higher AUTOINCREMENT id than any survivor row from that era. A second
 * prune that deletes the first tombstone would make "last deleted by id" point to the tombstone —
 * but the first survivor's prev_hash points to the last regular deleted row, not the tombstone.
 * Using the first survivor's prev_hash as the boundary fixes this: it is always the hash the
 * survivor was originally written against, regardless of how many tombstones have since been
 * stacked on top.
 *
 * When nothing qualifies (`prunedCount === 0`) the function is a no-op: no tombstone is
 * written and the chain is not touched.
 *
 * Owner-HITL-gated upstream (the `egress.prune` action joins the I2 frozen set). Writes via
 * `dbRun` (I14/D12); bound params only (I9).
 */
export function pruneEgress(
  db: Database,
  beforeTs: number,
  now: number,
): { prunedCount: number; boundaryHash?: string } {
  const before = Math.floor(beforeTs);

  // ── run everything inside a single transaction (atomic; crash leaves it intact) ──
  let prunedCount = 0;
  let boundaryHash: string | undefined;

  db.transaction(() => {
    // 1. Identify rows to delete (ordered by id ascending).
    //    row_hash is captured here for the full-prune fallback (no survivors); in the partial-prune
    //    case the correct boundary is the first survivor's prev_hash — see step 4 below.
    const toDelete = db
      .query(`SELECT id, row_hash FROM egress_ledger WHERE timestamp < ? ORDER BY id ASC`)
      .all(before) as { id: number; row_hash: string }[];

    prunedCount = toDelete.length;

    // No-op: nothing to prune → skip tombstone entirely.
    if (prunedCount === 0) return;

    // 2. DELETE the qualifying rows (I14/D12, I9).
    dbRun(db, `DELETE FROM egress_ledger WHERE timestamp < ?`, [before]);

    // 3. Surviving rows are NOT touched — their prev_hash/row_hash stay as originally written.

    // 4. Determine boundaryHash — the hash the first surviving row was chained against.
    //    Use the first survivor's prev_hash: it is the exact hash the survivor was written
    //    against, even when a prior tombstone row (appended after regular survivors, so it has
    //    a higher id) was itself deleted in this prune pass.  When such a tombstone is deleted
    //    its row_hash ≠ the first survivor's prev_hash, so the old "last deleted by id" approach
    //    would store the wrong boundary.
    //    When all rows were deleted (full prune) there is no survivor; fall back to the
    //    last-deleted row's row_hash (by id = monotonic AUTOINCREMENT order, I14/D12).
    const firstSurvivor = db
      .query(`SELECT prev_hash FROM egress_ledger ORDER BY id ASC LIMIT 1`)
      .get() as { prev_hash: string } | null | undefined;

    if (firstSurvivor != null) {
      // Partial prune: boundary = prev_hash of the first surviving row.
      boundaryHash = firstSurvivor.prev_hash;
    } else {
      // Full prune: no survivors — boundary = last-deleted row's row_hash (monotonic id order).
      const lastDeleted = toDelete.at(-1);
      if (lastDeleted === undefined) return; // unreachable; guarded by prunedCount > 0
      boundaryHash = lastDeleted.row_hash;
    }

    // 5. Append the tombstone. appendEgressEntry calls readHeadHash() internally, which will see
    //    the post-delete head (last surviving row or GENESIS_HASH) since we are on the same
    //    connection / same transaction. boundaryHash is stored in source_id — a hashed field in
    //    computeEgressRowHash — making the attestation tamper-evident.
    appendEgressEntry(db, {
      timestamp: now,
      sourceType: "prune",
      sourceId: boundaryHash,
      destination: "local",
      method: "egress.prune",
      payloadSummary: JSON.stringify({ before, prunedCount }),
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
  })();

  return { prunedCount, boundaryHash };
}
