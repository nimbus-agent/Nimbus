import type { Database } from "bun:sqlite";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { dbRun } from "../db/write.ts";
import { appendEgressEntry, computeEgressRowHash } from "./egress-ledger.ts";

type SurvivingRow = {
  id: number;
  timestamp: number;
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  result_status: string;
};

/**
 * Re-roots `rows` onto `fromHash`, updating each row's `prev_hash` and `row_hash` in id order so
 * the chain remains contiguous from `fromHash` after the prefix deletion. Writes via `dbRun`
 * (I14/D12). Returns the `row_hash` of the last row updated (= the new chain head after re-root).
 */
function reRootChain(db: Database, rows: SurvivingRow[], fromHash: string): string {
  let prev = fromHash;
  for (const r of rows) {
    const rowHash = computeEgressRowHash({
      prevHash: prev,
      timestamp: r.timestamp,
      sourceType: r.source_type,
      sourceId: r.source_id,
      destination: r.destination,
      method: r.method,
      resultStatus: r.result_status,
    });
    dbRun(db, `UPDATE egress_ledger SET prev_hash = ?, row_hash = ? WHERE id = ?`, [
      prev,
      rowHash,
      r.id,
    ]);
    prev = rowHash;
  }
  return prev;
}

/**
 * The ONLY sanctioned mutation of the egress ledger. Deletes whole rows with `timestamp < beforeTs`,
 * re-roots the surviving rows onto `GENESIS_HASH` (a cascading UPDATE so the chain stays intact),
 * then appends a continuing `source_type='prune'` tombstone that records the prune event. The
 * tombstone chains from the new surviving head (or from GENESIS_HASH when no rows survive), so the
 * entire ledger verifies without a silent gap before or after the tombstone.
 *
 * Owner-HITL-gated upstream (the `egress.prune` action joins the I2 frozen set; Task 7). Writes via
 * `dbRun` (I14/D12); bound params only (I9).
 */
export function pruneEgress(db: Database, beforeTs: number, now: number): { prunedCount: number } {
  const before = Math.floor(beforeTs);

  // Count rows that will be deleted (bound param — I9).
  const prunedCount = (
    db.query(`SELECT COUNT(*) as c FROM egress_ledger WHERE timestamp < ?`).get(before) as {
      c: number;
    }
  ).c;

  // Capture surviving rows (in id order) BEFORE deletion so we can re-root them.
  const surviving = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, result_status
       FROM egress_ledger WHERE timestamp >= ? ORDER BY id ASC`,
    )
    .all(before) as SurvivingRow[];

  // Delete the prefix (I14/D12, I9).
  dbRun(db, `DELETE FROM egress_ledger WHERE timestamp < ?`, [before]);

  // Re-root surviving rows from GENESIS_HASH so the chain is contiguous after the gap (I14/I9).
  reRootChain(db, surviving, GENESIS_HASH);

  // Append the tombstone: chains from the current head (last surviving row or GENESIS_HASH).
  appendEgressEntry(db, {
    timestamp: now,
    sourceType: "prune",
    sourceId: null,
    destination: "local",
    method: "egress.prune",
    payloadSummary: JSON.stringify({ before, prunedCount }),
    hitlStatus: "approved",
    resultStatus: "authorized",
  });

  return { prunedCount };
}
