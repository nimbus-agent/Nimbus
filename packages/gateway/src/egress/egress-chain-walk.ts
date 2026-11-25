import type { Database } from "bun:sqlite";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { computeEgressRowHash } from "./egress-ledger.ts";

/** Every field the row hash is computed over, plus the two chain hashes (never `payload_summary`). */
export type VerifyRow = {
  id: number;
  timestamp: number;
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  hitl_status: string;
  result_status: string;
  row_hash: string;
  prev_hash: string;
};

/** What a failed walk reports; the same shape `verifyEgressChain` returns for a failure. */
export type ChainBreak = {
  ok: false;
  verifiedRows: number;
  brokenAt: number;
  reason: string;
};

/** Where the walk stands: the hash the next row must link to, and how many rows have verified. */
export type ChainWalk = { prev: string; verified: number; isFirst: boolean; after: number };

/** Pre-scan: collect every boundary hash attested by a prune tombstone (source_id on prune rows). */
export function readAttestedBoundaries(db: Database): Set<string> {
  return new Set<string>(
    (
      db
        .query(
          `SELECT source_id FROM egress_ledger WHERE source_type = 'prune' AND source_id IS NOT NULL`,
        )
        .all() as { source_id: string }[]
    ).map((r) => r.source_id),
  );
}

/** The `row_hash` the first row after `start` must link to (genesis from the very start). */
export function readStartHash(db: Database, start: number): string {
  if (start <= 0) return GENESIS_HASH;
  const row = db.query(`SELECT row_hash FROM egress_ledger WHERE id = ?`).get(start) as
    | { row_hash: string }
    | undefined;
  return row?.row_hash ?? GENESIS_HASH;
}

/**
 * Verifies one page of rows in order, advancing `walk`; returns the failure at the first row whose
 * `prev_hash` or `row_hash` does not check out, or `null` when the whole page verified. Both checks
 * stay together here, in order, for every row.
 */
export function verifyPageRows(
  rows: readonly VerifyRow[],
  walk: ChainWalk,
  attestedBoundaries: ReadonlySet<string>,
): ChainBreak | null {
  for (const r of rows) {
    if (!sha256HexEqualConstantTime(r.prev_hash, walk.prev)) {
      // Accept a boundary mismatch only at the very first row of the walk when the prev_hash is
      // an attested prune boundary. A mid-chain mismatch is always a real break (fail-closed).
      if (walk.isFirst && attestedBoundaries.has(r.prev_hash)) {
        // Legitimate prune boundary: advance `prev` to the attested boundary so the row_hash
        // recomputation below uses the correct prevHash the row was originally written with.
        walk.prev = r.prev_hash;
      } else {
        return {
          ok: false,
          verifiedRows: walk.verified,
          brokenAt: r.id,
          reason: `prev_hash mismatch at id ${String(r.id)}`,
        };
      }
    }
    const expected = computeEgressRowHash({
      prevHash: walk.prev,
      timestamp: r.timestamp,
      sourceType: r.source_type,
      sourceId: r.source_id,
      destination: r.destination,
      method: r.method,
      hitlStatus: r.hitl_status,
      resultStatus: r.result_status,
    });
    if (!sha256HexEqualConstantTime(expected, r.row_hash)) {
      return {
        ok: false,
        verifiedRows: walk.verified,
        brokenAt: r.id,
        reason: `row_hash mismatch at id ${String(r.id)}`,
      };
    }
    walk.prev = r.row_hash;
    walk.verified += 1;
    walk.isFirst = false;
    walk.after = r.id;
  }
  return null;
}
