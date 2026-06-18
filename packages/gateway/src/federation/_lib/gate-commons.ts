/**
 * gate-commons.ts — shared consent preamble for inbound federation gates.
 *
 * SECURITY NOTE (I17 / D13): this file MUST NOT import `item-list-query` or `buildItemListSql`.
 * The leak-proof scope compilation (declaredServices / declaredTypes / computeEffectiveTypes /
 * no-full-index-dump checks) stays in `query-gate.ts`, the sole sanctioned federated-answer site.
 * The static audit `checkFederationImportInvariant` enforces this at CI time.
 */
import type { Database } from "bun:sqlite";
import type { SessionConsentCache } from "../consent-cache.ts";
import { appendFederationAudit, type FederationAuditFields } from "../federation-audit.ts";
import type { NamespaceStore } from "../namespace-store.ts";
import type { ConsentDecision, ConsentPrompter } from "../query-gate.ts";
import type { FederationDecision, FederationWireError } from "../types.ts";

export interface CommonGateContext {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly consentCache: SessionConsentCache;
  readonly prompt: ConsentPrompter;
  readonly consentTimeoutMs: number;
  readonly now?: () => number;
  /** I18: when identity is enabled, the answerer's own operator identity must be valid to federate. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

/** Minimal inbound request shape needed for the gate preamble. */
export interface GatePreambleRequest {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
}

export type GateErrorResult = { readonly kind: "error"; readonly error: FederationWireError };

/** The IPC method name recorded in the federation audit log (narrow literal union). */
export type FederationAuditMethod = FederationAuditFields["method"];

function auditDecision(
  ctx: CommonGateContext,
  req: GatePreambleRequest,
  decision: FederationDecision,
  method: FederationAuditMethod,
): void {
  const nowMs = (ctx.now ?? Date.now)();
  appendFederationAudit(ctx.db, {
    peerId: req.peerId,
    namespace: req.namespace,
    purpose: req.purpose,
    decision,
    method,
    timestamp: nowMs,
  });
}

export function withTimeout(p: Promise<ConsentDecision>, ms: number): Promise<ConsentDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<ConsentDecision>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

/**
 * Shared consent preamble: I18 identity check → namespace-exists → active-grant →
 * consent (cache / prompt / timeout).
 *
 * Returns `undefined` when all checks pass (caller proceeds with its own tail logic).
 * Returns a `GateErrorResult` on any failure (caller must return it immediately).
 *
 * @param method - The IPC method name used for audit logging (e.g. "federation.query").
 */
export async function enforceCommonGate(
  ctx: CommonGateContext,
  req: GatePreambleRequest,
  method: FederationAuditMethod,
): Promise<GateErrorResult | undefined> {
  // I18: identity guard — audited precisely; returns same opaque denial as no_grant (no leak).
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    auditDecision(ctx, req, "identity_invalid", method);
    return { kind: "error", error: "no_grant" };
  }

  const ns = ctx.store.getByName(req.namespace);
  if (ns === undefined) {
    auditDecision(ctx, req, "namespace_unknown", method);
    return { kind: "error", error: "namespace_unknown" };
  }

  // Live-checked grant — revocation takes effect immediately.
  const grant = ctx.store.getActiveGrant(req.namespace, req.peerId);
  if (grant === undefined) {
    auditDecision(ctx, req, "no_grant", method);
    return { kind: "error", error: "no_grant" };
  }

  // Consent: standing grant never prompts; otherwise use session cache or prompt with a timeout.
  if (!grant.standingConsent) {
    const cached = ctx.consentCache.get(req.peerId, req.namespace);
    if (cached === false) {
      auditDecision(ctx, req, "consent_denied", method);
      return { kind: "error", error: "consent_denied" };
    }
    if (cached === undefined) {
      const decision = await withTimeout(
        ctx.prompt({
          peerId: req.peerId,
          namespace: req.namespace,
          purpose: req.purpose,
          role: grant.role,
        }),
        ctx.consentTimeoutMs,
      );
      if (decision === "timeout") {
        auditDecision(ctx, req, "timeout", method);
        return { kind: "error", error: "timeout_waiting_for_consent" };
      }
      const approved = decision === "approved";
      ctx.consentCache.set(req.peerId, req.namespace, approved);
      if (!approved) {
        auditDecision(ctx, req, "consent_denied", method);
        return { kind: "error", error: "consent_denied" };
      }
    }
  }

  return undefined;
}
