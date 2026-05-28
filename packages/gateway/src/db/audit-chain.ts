import type { Database } from "bun:sqlite";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { dbRun } from "./write.ts";

export const GENESIS_HASH = "0".repeat(64);

export type AuditRowHashInput = {
  prevHash: string;
  actionType: string;
  hitlStatus: string;
  actionJson: string;
  timestamp: number;
};

export function computeAuditRowHash(input: AuditRowHashInput): string {
  const encoder = new TextEncoder();
  const payload = encoder.encode(
    `${input.prevHash}|${input.actionType}|${input.hitlStatus}|${input.actionJson}|${String(input.timestamp)}`,
  );
  return bytesToHex(blake3(payload));
}

export interface AppendAuditEntryFields {
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly actionJson: string;
  readonly timestamp: number;
  readonly sessionId?: string;
}

export function appendAuditEntry(db: Database, fields: AppendAuditEntryFields): void {
  const rawPrev = db.query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
    | { row_hash: string | null }
    | undefined;
  const h = rawPrev?.row_hash;
  const prevHash = typeof h === "string" && h.length === 64 ? h : GENESIS_HASH;
  const rowHash = computeAuditRowHash({
    prevHash,
    actionType: fields.actionType,
    hitlStatus: fields.hitlStatus,
    actionJson: fields.actionJson,
    timestamp: fields.timestamp,
  });
  dbRun(
    db,
    `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.actionType,
      fields.hitlStatus,
      fields.actionJson,
      fields.timestamp,
      rowHash,
      prevHash,
      fields.sessionId ?? null,
    ],
  );
}
