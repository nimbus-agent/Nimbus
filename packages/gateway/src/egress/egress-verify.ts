import type { Database } from "bun:sqlite";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { computeEgressRowHash } from "./egress-ledger.ts";
import { isMarkerSourceType } from "./egress-source-type.ts";

/** Hard ceiling on `listEgress` rows — bounds the cost of an IPC-supplied `limit`. */
const MAX_EGRESS_LIST_LIMIT = 5000;

export type EgressRow = {
  id: number;
  timestamp: number;
  sourceType: string;
  sourceId: string | null;
  destination: string;
  method: string;
  payloadSummary: string;
  hitlStatus: string;
  resultStatus: string;
  rowHash: string;
  prevHash: string;
};

type RawRow = {
  id: number;
  timestamp: number;
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  payload_summary: string;
  hitl_status: string;
  result_status: string;
  row_hash: string;
  prev_hash: string;
};

function toRow(r: RawRow): EgressRow {
  return {
    id: r.id,
    timestamp: r.timestamp,
    sourceType: r.source_type,
    sourceId: r.source_id,
    destination: r.destination,
    method: r.method,
    payloadSummary: r.payload_summary,
    hitlStatus: r.hitl_status,
    resultStatus: r.result_status,
    rowHash: r.row_hash,
    prevHash: r.prev_hash,
  };
}

export type EgressVerifyResult = {
  ok: boolean;
  verifiedRows: number;
  brokenAt?: number;
  reason?: string;
};

/**
 * Walk the chain from `fromId` (exclusive), recompute each row hash, and compare with the
 * constant-time hex comparator (I10 — `sha256HexEqualConstantTime` works on any 64-char hex,
 * which is BLAKE3's output width — never `===`). A `prev_hash` discontinuity or a hash mismatch
 * fails closed with `brokenAt`.
 *
 * Attested-boundary rule: after a tombstone-boundary prune the first surviving segment starts
 * at a pruned boundary — its `prev_hash` equals the `row_hash` of the last deleted row, which is
 * no longer present. This is legitimate: the tombstone (`source_type='prune'`) records that
 * boundary hash in `source_id` (a field that IS part of `computeEgressRowHash`, making the
 * attestation tamper-evident). The verifier pre-scans all prune tombstones to collect the set of
 * attested boundaries and accepts a `prev_hash` mismatch at the START of the walk if (and only if)
 * the mismatched `prev_hash` is one of those attested boundaries. A mid-chain mismatch is still
 * a real break and fails closed.
 */
export function verifyEgressChain(db: Database, fromId = 0): EgressVerifyResult {
  const start = Math.max(0, Math.floor(fromId));

  // Pre-scan: collect every boundary hash attested by a prune tombstone (source_id on prune rows).
  const attestedBoundaries = new Set<string>(
    (
      db
        .query(
          `SELECT source_id FROM egress_ledger WHERE source_type = 'prune' AND source_id IS NOT NULL`,
        )
        .all() as { source_id: string }[]
    ).map((r) => r.source_id),
  );

  const rows = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
              hitl_status, result_status, row_hash, prev_hash
       FROM egress_ledger WHERE id > ? ORDER BY id ASC`,
    )
    .all(start) as RawRow[];

  let prev =
    start > 0
      ? ((
          db.query(`SELECT row_hash FROM egress_ledger WHERE id = ?`).get(start) as
            | { row_hash: string }
            | undefined
        )?.row_hash ?? GENESIS_HASH)
      : GENESIS_HASH;

  let verified = 0;
  let isFirst = true;
  for (const r of rows) {
    if (!sha256HexEqualConstantTime(r.prev_hash, prev)) {
      // Accept a boundary mismatch only at the very first row of the walk when the prev_hash is
      // an attested prune boundary. A mid-chain mismatch is always a real break (fail-closed).
      if (isFirst && attestedBoundaries.has(r.prev_hash)) {
        // Legitimate prune boundary: advance `prev` to the attested boundary so the row_hash
        // recomputation below uses the correct prevHash the row was originally written with.
        prev = r.prev_hash;
      } else {
        return {
          ok: false,
          verifiedRows: verified,
          brokenAt: r.id,
          reason: `prev_hash mismatch at id ${String(r.id)}`,
        };
      }
    }
    const expected = computeEgressRowHash({
      prevHash: prev,
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
        verifiedRows: verified,
        brokenAt: r.id,
        reason: `row_hash mismatch at id ${String(r.id)}`,
      };
    }
    prev = r.row_hash;
    verified += 1;
    isFirst = false;
  }
  return { ok: true, verifiedRows: verified };
}

export function egressHead(db: Database): { head: string; count: number } {
  const head =
    (
      db.query(`SELECT row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`).get() as
        | { row_hash: string }
        | undefined
    )?.row_hash ?? GENESIS_HASH;
  const count = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
  return { head, count };
}

export function listEgress(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined; limit?: number | undefined },
): EgressRow[] {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  // Clamp to a hard ceiling: `egress.list` flows from IPC, so an arbitrarily large positive limit
  // could force an expensive scan/allocation on a large ledger.
  const requested = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 1000;
  const limit = Math.min(requested, MAX_EGRESS_LIST_LIMIT);
  const rows = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
              hitl_status, result_status, row_hash, prev_hash
       FROM egress_ledger WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC LIMIT ?`,
    )
    .all(since, until, limit) as RawRow[];
  return rows.map(toRow);
}

export type EgressCompleteness = { tier: "authorized-actions"; outboundEgressEvents: number };

/**
 * The `nimbus prove` window: the rows in [since, until], the completeness tier (honest about the
 * "authorized-actions" boundary — does NOT claim raw-syscall capture, per the spec), and the chain
 * verify result. A degraded chain surfaces `verify.ok === false` — the CLI prints `indeterminate`,
 * never a false `0` (the EAF "indeterminate, never a false zero" rule).
 *
 * NOTE — `verify` runs `verifyEgressChain` over the WHOLE ledger (fromId = 0), not just the
 * window rows. This is intentional and fail-closed: the "zero egress in window W" inference is
 * only sound if the entire chain is intact. A row deleted or relinked outside the window would
 * corrupt the `prev_hash` linkage of a later row without touching any row inside the window, so a
 * window-scoped verify would silently miss it. If `verify.ok === false`, the ledger's integrity is
 * in question even when the window's own rows appear fine.
 */
export function proveWindow(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined },
): { rows: EgressRow[]; completeness: EgressCompleteness; verify: EgressVerifyResult } {
  const rows = listEgress(db, {
    ...(opts.since !== undefined && { since: opts.since }),
    ...(opts.until !== undefined && { until: opts.until }),
  });
  const outbound = rows.filter(
    (r) => r.resultStatus === "authorized" && !isMarkerSourceType(r.sourceType),
  ).length;
  return {
    rows,
    completeness: { tier: "authorized-actions", outboundEgressEvents: outbound },
    verify: verifyEgressChain(db),
  };
}
