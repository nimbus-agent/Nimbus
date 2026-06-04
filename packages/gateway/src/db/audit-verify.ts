import type { LocalIndex } from "../index/local-index.ts";
import { computeAuditRowHash, GENESIS_HASH } from "./audit-chain.ts";

export type AuditVerifyOptions = {
  fromId: number;
};

export type AuditVerifyResult = {
  ok: boolean;
  verifiedRows: number;
  lastVerifiedId: number;
  firstBreakAtId?: number;
  reason?: string;
};

export function verifyAuditChain(idx: LocalIndex, opts: AuditVerifyOptions): AuditVerifyResult {
  const rows = idx.rawDb
    .query(
      `SELECT id, action_type, hitl_status, action_json, timestamp, row_hash, prev_hash, federation_json
       FROM audit_log WHERE id > ? ORDER BY id ASC`,
    )
    .all(Math.max(0, Math.floor(opts.fromId))) as Array<{
    id: number;
    action_type: string;
    hitl_status: string;
    action_json: string;
    timestamp: number;
    row_hash: string;
    prev_hash: string;
    federation_json: string | null;
  }>;

  let prev =
    opts.fromId > 0
      ? ((
          idx.rawDb.query(`SELECT row_hash FROM audit_log WHERE id = ?`).get(opts.fromId) as
            | { row_hash: string }
            | undefined
        )?.row_hash ?? GENESIS_HASH)
      : GENESIS_HASH;

  let verified = 0;
  let lastId = opts.fromId;

  for (const r of rows) {
    if (r.prev_hash !== prev) {
      return {
        ok: false,
        verifiedRows: verified,
        lastVerifiedId: lastId,
        firstBreakAtId: r.id,
        reason: `prev_hash mismatch at id ${String(r.id)}`,
      };
    }
    const expected = computeAuditRowHash({
      prevHash: prev,
      actionType: r.action_type,
      hitlStatus: r.hitl_status,
      actionJson: r.action_json,
      timestamp: r.timestamp,
      federationJson: r.federation_json ?? null,
    });
    if (expected !== r.row_hash) {
      return {
        ok: false,
        verifiedRows: verified,
        lastVerifiedId: lastId,
        firstBreakAtId: r.id,
        reason: `row_hash mismatch at id ${String(r.id)}`,
      };
    }
    prev = r.row_hash;
    verified += 1;
    lastId = r.id;
  }

  return { ok: true, verifiedRows: verified, lastVerifiedId: lastId };
}
