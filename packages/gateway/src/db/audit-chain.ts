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
  federationJson?: string | null;
};

export function computeAuditRowHash(input: AuditRowHashInput): string {
  const encoder = new TextEncoder();
  const base = `${input.prevHash}|${input.actionType}|${input.hitlStatus}|${input.actionJson}|${String(input.timestamp)}`;
  const withFed =
    typeof input.federationJson === "string" && input.federationJson.length > 0
      ? `${base}|${input.federationJson}`
      : base;
  return bytesToHex(blake3(encoder.encode(withFed)));
}

export interface AppendAuditEntryFields {
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly actionJson: string;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly federationJson?: string | null;
}

/**
 * Whether this database's `audit_log` has the V33 `federation_json` column. Cached per `Database`
 * (a connection's schema is fixed for its serving lifetime — migrations run before any audit
 * append). This lets `appendAuditEntry` / `verifyAuditChain` work on BOTH a pre-V33 `audit_log`
 * (e.g. a test DB seeded to an older schema version) and a V33+ table: the column is written/read
 * only when it exists, and a pre-V33 row hashes exactly as it did before V33.
 */
const FEDERATION_COLUMN_CACHE = new WeakMap<Database, boolean>();

export function auditLogHasFederationJson(db: Database): boolean {
  const cached = FEDERATION_COLUMN_CACHE.get(db);
  if (cached !== undefined) {
    return cached;
  }
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(audit_log)`).all();
  const has = cols.some((c) => c.name === "federation_json");
  FEDERATION_COLUMN_CACHE.set(db, has);
  return has;
}

export function appendAuditEntry(db: Database, fields: AppendAuditEntryFields): void {
  const rawPrev = db.query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
    | { row_hash: string | null }
    | undefined;
  const h = rawPrev?.row_hash;
  const prevHash = typeof h === "string" && h.length === 64 ? h : GENESIS_HASH;
  // On a pre-V33 audit_log the column does not exist — force null so the row hashes exactly as it
  // did before V33 and the INSERT omits the column (backward-compatible with older schemas).
  const federationJson = auditLogHasFederationJson(db) ? (fields.federationJson ?? null) : null;
  const rowHash = computeAuditRowHash({
    prevHash,
    actionType: fields.actionType,
    hitlStatus: fields.hitlStatus,
    actionJson: fields.actionJson,
    timestamp: fields.timestamp,
    federationJson,
  });
  if (auditLogHasFederationJson(db)) {
    dbRun(
      db,
      `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash, session_id, federation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fields.actionType,
        fields.hitlStatus,
        fields.actionJson,
        fields.timestamp,
        rowHash,
        prevHash,
        fields.sessionId ?? null,
        federationJson,
      ],
    );
    return;
  }
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
