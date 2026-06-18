import type { Database } from "bun:sqlite";
import { enforceCommonGate } from "./_lib/gate-commons.ts";
import type { SessionConsentCache } from "./consent-cache.ts";
import { appendFederationAudit } from "./federation-audit.ts";
import type { NamespaceStore } from "./namespace-store.ts";
import type { ConsentPrompter } from "./query-gate.ts";
import type { FederationWireError } from "./types.ts";

export interface FederationAuditEntry {
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly hash: string;
  readonly timestamp: number;
}

/** Federation-only, metadata-only audit slice (leak-proof — never selects/returns `action_json`). */
export function exportFederationAudit(
  db: Database,
  opts: { sinceMs: number },
): FederationAuditEntry[] {
  const rows = db
    .query(
      "SELECT action_type, hitl_status, row_hash, timestamp FROM audit_log WHERE action_type LIKE 'federation.%' AND timestamp >= ? ORDER BY timestamp ASC",
    )
    .all(opts.sinceMs) as {
    action_type: string;
    hitl_status: string;
    row_hash: string;
    timestamp: number;
  }[];
  return rows.map((r) => ({
    actionType: r.action_type,
    hitlStatus: r.hitl_status,
    hash: r.row_hash,
    timestamp: r.timestamp,
  }));
}

export interface AuditExportGateCtx {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly consentCache: SessionConsentCache;
  readonly prompt: ConsentPrompter;
  readonly consentTimeoutMs: number;
  readonly now?: () => number;
  /** I18: when identity is enabled, the answerer's own operator identity must be valid to federate. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface InboundAuditExport {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly sinceMs: number;
}

export type AuditExportResult =
  | { readonly kind: "ok"; readonly entries: FederationAuditEntry[] }
  | { readonly kind: "error"; readonly error: FederationWireError };

/**
 * Consent-gated answer for an inbound `federation.auditExport`. Delegates the shared preamble
 * (I18 identity guard → namespace exists → live-checked grant → standing/cached/prompted consent)
 * to `enforceCommonGate`, then audits the "answered" outcome and returns the FEDERATION-only,
 * METADATA-only audit slice (never `action_json`). Fail-closed: any unmet gate returns an opaque
 * wire error and NO audit data.
 *
 * The namespace+grant is the access-control subject (the requester must already hold a federation
 * grant the same way it must to run `federation.query`); the returned slice itself is namespace-
 * independent (a flat federation-metadata view of THIS gateway's audit log).
 */
export async function answerFederatedAuditExport(
  ctx: AuditExportGateCtx,
  q: InboundAuditExport,
): Promise<AuditExportResult> {
  // I17/I18 preamble: identity check → namespace-exists → active-grant → consent.
  const preambleError = await enforceCommonGate(
    ctx,
    { peerId: q.peerId, namespace: q.namespace, purpose: q.purpose },
    "federation.auditExport",
  );
  if (preambleError !== undefined) {
    return preambleError;
  }

  // Audit the granted outcome (federation metadata only — never the exported slice content).
  appendFederationAudit(ctx.db, {
    peerId: q.peerId,
    namespace: q.namespace,
    purpose: q.purpose,
    decision: "answered",
    method: "federation.auditExport",
    timestamp: (ctx.now ?? Date.now)(),
  });

  return { kind: "ok", entries: exportFederationAudit(ctx.db, { sinceMs: q.sinceMs }) };
}
