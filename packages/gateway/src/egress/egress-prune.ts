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
 * carries `boundaryHash` (the `row_hash` of the last deleted row). `source_id` is part of
 * `computeEgressRowHash`, so the attestation is tamper-evident. `verifyEgressChain` accepts
 * the attested boundary as a legitimate chain start for the surviving segment.
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
    // 1. Identify rows to delete (ordered by id ascending; last = highest-id row).
    const toDelete = db
      .query(`SELECT id, row_hash FROM egress_ledger WHERE timestamp < ? ORDER BY id ASC`)
      .all(before) as { id: number; row_hash: string }[];

    prunedCount = toDelete.length;

    // No-op: nothing to prune → skip tombstone entirely.
    if (prunedCount === 0) return;

    // 2. Capture boundaryHash = row_hash of the LAST deleted row (= prev_hash of first survivor).
    //    Array.at(-1) returns undefined only when length === 0, which is guarded above.
    const lastHash = toDelete.at(-1)?.row_hash;
    if (lastHash === undefined) return; // unreachable; satisfies the type checker
    boundaryHash = lastHash;

    // 3. DELETE the qualifying rows (I14/D12, I9).
    dbRun(db, `DELETE FROM egress_ledger WHERE timestamp < ?`, [before]);

    // 4. Surviving rows are NOT touched — their prev_hash/row_hash stay as originally written.

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
