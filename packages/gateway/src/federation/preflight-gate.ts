import type { Database } from "bun:sqlite";
import type { PreflightCommandConfig } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { PreflightApprovalInput } from "./preflight-consent-broker.ts";
import {
  type PreflightRunParams,
  type PreflightRunResult,
  runPreflightCommand,
} from "./preflight-runner.ts";

const REF_RE = /^[A-Za-z0-9_./~^-]+$/;
const SURFACE_SYMBOL_RE = /^[A-Za-z0-9_.:#/-]+$/;
const MAX_SURFACE = 200;

export type PreflightDecision = "answered" | "no_grant" | "not_configured" | "denied" | "invalid";

export interface PreflightGateCtx {
  /** True iff the peer holds an active grant on the namespace (NamespaceStore.getActiveGrant). */
  readonly isPeerGranted: (namespace: string, peerId: string) => boolean;
  /** Resolve the LOCAL config command for the namespace; undefined → not configured (fail-closed). */
  readonly resolveCommand: (namespace: string) => PreflightCommandConfig | undefined;
  /** Local owner HITL approval (PreflightConsentBroker.request). */
  readonly requestApproval: (input: PreflightApprovalInput) => Promise<boolean>;
  /** Run the configured command in the sandbox (preflight-runner.runPreflightCommand). */
  readonly runCommand: (
    cfg: PreflightCommandConfig,
    params: PreflightRunParams,
  ) => Promise<PreflightRunResult>;
  /** Audit each outcome (durationMs present on a real run). */
  readonly audit: (entry: {
    decision: PreflightDecision;
    peerId: string;
    namespace: string;
    durationMs?: number;
  }) => void;
  /** I18: when identity is enabled, the operator must be valid to serve. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

/**
 * The inbound request. A caller-supplied `command`/`cmd`/`args` field is intentionally NOT modeled
 * here — it is ignored. The command that runs is resolved ONLY from local config (I24).
 */
export interface InboundPreflight {
  readonly peerId: string;
  readonly namespace: string;
  readonly ref: string;
  readonly changedSurface: readonly string[];
  readonly purpose: string;
}

export type PreflightResult =
  | { readonly kind: "ok"; readonly passed: boolean; readonly summary: string }
  | { readonly kind: "error"; readonly error: "no_grant" | "not_configured" | "denied" };

function validRequest(q: InboundPreflight): boolean {
  if (!REF_RE.test(q.ref)) return false;
  if (q.changedSurface.length > MAX_SURFACE) return false;
  return q.changedSurface.every((s) => SURFACE_SYMBOL_RE.test(s));
}

/**
 * I24 — the SOLE path from an inbound federation.preflight to a sandbox spawn.
 * identity → validate → grant → resolve-LOCAL-command → LOCAL HITL approval → sandbox-run.
 * The caller never selects or supplies the command; missing config fails closed; no path/body leaks.
 */
export async function answerFederatedPreflight(
  ctx: PreflightGateCtx,
  q: InboundPreflight,
): Promise<PreflightResult> {
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    ctx.audit({ decision: "no_grant", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" };
  }
  if (!validRequest(q)) {
    ctx.audit({ decision: "invalid", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" }; // opaque
  }
  if (!ctx.isPeerGranted(q.namespace, q.peerId)) {
    ctx.audit({ decision: "no_grant", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" };
  }
  const cfg = ctx.resolveCommand(q.namespace);
  if (cfg === undefined) {
    ctx.audit({ decision: "not_configured", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "not_configured" };
  }
  const approved = await ctx.requestApproval({
    peerId: q.peerId,
    namespace: q.namespace,
    ref: q.ref,
    purpose: q.purpose,
  });
  if (!approved) {
    ctx.audit({ decision: "denied", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "denied" };
  }
  const result = await ctx.runCommand(cfg, { ref: q.ref, changedSurface: q.changedSurface });
  ctx.audit({
    decision: "answered",
    peerId: q.peerId,
    namespace: q.namespace,
    durationMs: result.durationMs,
  });
  return { kind: "ok", passed: result.passed, summary: result.summary };
}

/**
 * The production `runCommand` thunk. Lives here (an allowed D18 site) so the sole `runPreflightCommand`
 * call sites stay confined to preflight-gate.ts + preflight-runner.ts (I24 static complement).
 */
export const defaultRunCommand: PreflightGateCtx["runCommand"] = (cfg, params) =>
  runPreflightCommand(cfg, params);

/**
 * The production `audit` thunk: appends a leak-proof `federation.preflight.<decision>` row to the
 * tamper-evident audit log (peerId + namespace + run duration only — never the ref, command, or
 * any output). Wired into the gate ctx by the dispatcher / LAN server.
 */
export function appendPreflightAudit(
  db: Database,
  entry: { decision: PreflightDecision; peerId: string; namespace: string; durationMs?: number },
): void {
  // audit_log.hitl_status is CHECK-constrained to approved|rejected|not_required. `answered` ran
  // after a local approval; `denied` was owner-rejected; the fail-closed pre-HITL decisions
  // (no_grant / not_configured / invalid) never reached the gate → not_required.
  const hitlStatus =
    entry.decision === "answered"
      ? "approved"
      : entry.decision === "denied"
        ? "rejected"
        : "not_required";
  appendAuditEntry(db, {
    actionType: `federation.preflight.${entry.decision}`,
    hitlStatus,
    actionJson: JSON.stringify({
      peerId: entry.peerId,
      namespace: entry.namespace,
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    }),
    timestamp: Date.now(),
  });
}
