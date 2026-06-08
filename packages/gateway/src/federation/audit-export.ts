import type { Database } from "bun:sqlite";
import type { SessionConsentCache } from "./consent-cache.ts";
import { appendFederationAudit } from "./federation-audit.ts";
import type { NamespaceStore } from "./namespace-store.ts";
import type { ConsentDecision, ConsentPrompter } from "./query-gate.ts";
import type { FederationDecision, FederationWireError } from "./types.ts";

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

/** Audit one gate decision, mirroring query-gate's `audit()` — federation metadata only, never
 *  any exported audit_log row content (the slice itself is never logged). */
function audit(ctx: AuditExportGateCtx, q: InboundAuditExport, decision: FederationDecision): void {
  const nowMs = (ctx.now ?? Date.now)();
  appendFederationAudit(ctx.db, {
    peerId: q.peerId,
    namespace: q.namespace,
    purpose: q.purpose,
    decision,
    method: "federation.auditExport",
    timestamp: nowMs,
  });
}

function withTimeout(p: Promise<ConsentDecision>, ms: number): Promise<ConsentDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<ConsentDecision>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

/**
 * Consent-gated answer for an inbound `federation.auditExport`. Mirrors `answerFederatedQuery`'s
 * gating EXACTLY (I18 identity guard → namespace exists → live-checked grant → standing/cached/
 * prompted consent), then returns the FEDERATION-only, METADATA-only audit slice (never
 * `action_json`). Fail-closed: any unmet gate returns an opaque wire error and NO audit data.
 *
 * The namespace+grant is the access-control subject (the requester must already hold a federation
 * grant the same way it must to run `federation.query`); the returned slice itself is namespace-
 * independent (a flat federation-metadata view of THIS gateway's audit log).
 */
export async function answerFederatedAuditExport(
  ctx: AuditExportGateCtx,
  q: InboundAuditExport,
): Promise<AuditExportResult> {
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    // Audited precisely; over the wire we return the SAME opaque denial as no_grant (matches query-gate).
    audit(ctx, q, "identity_invalid");
    return { kind: "error", error: "no_grant" };
  }

  const ns = ctx.store.getByName(q.namespace);
  if (ns === undefined) {
    audit(ctx, q, "namespace_unknown");
    return { kind: "error", error: "namespace_unknown" };
  }

  // Live-checked grant — revocation takes effect immediately.
  const grant = ctx.store.getActiveGrant(q.namespace, q.peerId);
  if (grant === undefined) {
    audit(ctx, q, "no_grant");
    return { kind: "error", error: "no_grant" };
  }

  // Consent: standing grant never prompts; otherwise use session cache or prompt with a timeout.
  if (!grant.standingConsent) {
    const cached = ctx.consentCache.get(q.peerId, q.namespace);
    if (cached === false) {
      audit(ctx, q, "consent_denied");
      return { kind: "error", error: "consent_denied" };
    }
    if (cached === undefined) {
      const decision = await withTimeout(
        ctx.prompt({
          peerId: q.peerId,
          namespace: q.namespace,
          purpose: q.purpose,
          role: grant.role,
        }),
        ctx.consentTimeoutMs,
      );
      if (decision === "timeout") {
        audit(ctx, q, "timeout");
        return { kind: "error", error: "timeout_waiting_for_consent" };
      }
      const approved = decision === "approved";
      ctx.consentCache.set(q.peerId, q.namespace, approved);
      if (!approved) {
        audit(ctx, q, "consent_denied");
        return { kind: "error", error: "consent_denied" };
      }
    }
  }

  audit(ctx, q, "answered");
  return { kind: "ok", entries: exportFederationAudit(ctx.db, { sinceMs: q.sinceMs }) };
}
