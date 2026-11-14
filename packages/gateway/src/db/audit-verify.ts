import type { LocalIndex } from "../index/local-index.ts";
import { auditLogHasFederationJson, computeAuditRowHash, GENESIS_HASH } from "./audit-chain.ts";

/** Rows read per page while verifying; bounds memory, never the result. */
export const VERIFY_PAGE_ROWS = 1_000;

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
  // `federation_json` is a V33 column; SELECT it only when present so verification works on a
  // pre-V33 audit_log too (the fragment is a fixed literal — no caller data, I9-clean). A row
  // without the column reconstructs with federationJson = null, i.e. the legacy hash.
  const fedColumn = auditLogHasFederationJson(idx.rawDb) ? ", federation_json" : "";
  const fromId = Math.max(0, Math.floor(opts.fromId));
  type AuditVerifyRow = {
    id: number;
    action_type: string;
    hitl_status: string;
    action_json: string;
    timestamp: number;
    row_hash: string;
    prev_hash: string;
    federation_json?: string | null;
  };
  // Read in id-ordered pages so memory is bounded by one page, not by the table; the walk, its
  // result and its first-break id are the same as one read of every row.
  const page = idx.rawDb.query<AuditVerifyRow, [number, number]>(
    `SELECT id, action_type, hitl_status, action_json, timestamp, row_hash, prev_hash${fedColumn}
       FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?`,
  );

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

  let after = fromId;
  for (;;) {
    const rows = page.all(after, VERIFY_PAGE_ROWS);
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
      after = r.id;
    }
    if (rows.length < VERIFY_PAGE_ROWS) break;
  }

  return { ok: true, verifiedRows: verified, lastVerifiedId: lastId };
}
