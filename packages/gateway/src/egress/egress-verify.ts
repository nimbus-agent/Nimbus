import type { Database } from "bun:sqlite";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { computeEgressRowHash } from "./egress-ledger.ts";

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
 */
export function verifyEgressChain(db: Database, fromId = 0): EgressVerifyResult {
  const start = Math.max(0, Math.floor(fromId));
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
  for (const r of rows) {
    if (!sha256HexEqualConstantTime(r.prev_hash, prev)) {
      return {
        ok: false,
        verifiedRows: verified,
        brokenAt: r.id,
        reason: `prev_hash mismatch at id ${String(r.id)}`,
      };
    }
    const expected = computeEgressRowHash({
      prevHash: prev,
      timestamp: r.timestamp,
      sourceType: r.source_type,
      sourceId: r.source_id,
      destination: r.destination,
      method: r.method,
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
  opts: { since?: number; until?: number; limit?: number },
): EgressRow[] {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 1000;
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
 */
export function proveWindow(
  db: Database,
  opts: { since?: number; until?: number },
): { rows: EgressRow[]; completeness: EgressCompleteness; verify: EgressVerifyResult } {
  const rows = listEgress(db, { since: opts.since, until: opts.until });
  const outbound = rows.filter((r) => r.resultStatus === "authorized").length;
  return {
    rows,
    completeness: { tier: "authorized-actions", outboundEgressEvents: outbound },
    verify: verifyEgressChain(db),
  };
}
