import type { Database } from "bun:sqlite";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { dbRun } from "../db/write.ts";
import type { EgressEntry } from "./egress-record.ts";

export interface EgressRowHashInput {
  readonly prevHash: string;
  readonly timestamp: number;
  readonly sourceType: string;
  readonly sourceId: string | null;
  readonly destination: string;
  readonly method: string;
  readonly resultStatus: string;
}

/**
 * BLAKE3 row hash over `prev_hash | timestamp | source_type | source_id | destination | method |
 * result_status`. Mirrors `db/audit-chain.ts`'s `computeAuditRowHash` exactly (same blake3 +
 * bytesToHex primitive). `payload_summary` is intentionally NOT hashed: it is redacted/lossy and
 * a debugging aid, not part of the tamper-evident commitment.
 */
export function computeEgressRowHash(input: EgressRowHashInput): string {
  const encoder = new TextEncoder();
  const base = `${input.prevHash}|${String(input.timestamp)}|${input.sourceType}|${input.sourceId ?? ""}|${input.destination}|${input.method}|${input.resultStatus}`;
  return bytesToHex(blake3(encoder.encode(base)));
}

function readHeadHash(db: Database): string {
  const raw = db.query(`SELECT row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`).get() as
    | { row_hash: string | null }
    | undefined;
  const h = raw?.row_hash;
  return typeof h === "string" && h.length === 64 ? h : GENESIS_HASH;
}

/**
 * Append one egress row, chained to the current head. Append-only — this module exposes NO update
 * or delete path (the sole mutation lives in egress-prune.ts). Writes via `dbRun` (I14/D12).
 *
 * camelCase EgressEntry fields are mapped explicitly to snake_case columns; the spread is NEVER
 * used to avoid silently writing camelCase keys as column names.
 */
export function appendEgressEntry(db: Database, entry: EgressEntry): void {
  const prevHash = readHeadHash(db);
  const rowHash = computeEgressRowHash({
    prevHash,
    timestamp: entry.timestamp,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    destination: entry.destination,
    method: entry.method,
    resultStatus: entry.resultStatus,
  });
  dbRun(
    db,
    `INSERT INTO egress_ledger
		  (timestamp, source_type, source_id, destination, method, payload_summary, hitl_status, result_status, row_hash, prev_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.timestamp,
      entry.sourceType,
      entry.sourceId,
      entry.destination,
      entry.method,
      entry.payloadSummary,
      entry.hitlStatus,
      entry.resultStatus,
      rowHash,
      prevHash,
    ],
  );
}

/** The DI seam wired into `ToolExecutor` — appends to the given DB. */
export interface EgressSink {
  append(entry: EgressEntry): void;
}

export function makeEgressSink(db: Database): EgressSink {
  return {
    append(entry: EgressEntry): void {
      appendEgressEntry(db, entry);
    },
  };
}
