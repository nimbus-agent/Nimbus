import type { Database } from "bun:sqlite";
import { appendTeamVaultAudit, type TeamVaultDecision } from "../teamvault/team-vault-audit.ts";
import type { TeamVaultStore } from "../teamvault/team-vault-store.ts";

export interface QuorumRuleLite {
  readonly approvers: number;
  readonly windowSeconds: number;
}
export interface QuorumOutcomeLite {
  readonly outcome: "approved" | "denied" | "failed";
  readonly approvers: readonly string[];
}

export interface InvokeGateCtx {
  readonly db: Database;
  readonly store: TeamVaultStore;
  /** [hitl.quorum] lookup for the bound tool's action-type; undefined → no quorum. */
  readonly quorumFor: (toolId: string) => QuorumRuleLite | undefined;
  /** Run the quorum collection (QuorumCoordinator.collect adapted to seconds→ms). */
  readonly runQuorum: (rule: QuorumRuleLite) => Promise<QuorumOutcomeLite>;
  /**
   * Execute the tool on the anchor. The secret is fetched from the OS Vault and injected
   * INSIDE this callback (the anchor's wiring), so it is never in this gate's scope (I19).
   */
  readonly runTool: (input: {
    entry: string;
    service: string;
    toolId: string;
    args: unknown;
  }) => Promise<unknown>;
  readonly now?: () => number;
  /** I18: when identity is enabled, the anchor operator must be valid to serve a team credential. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface InboundInvoke {
  readonly peerId: string;
  readonly entry: string;
  readonly toolId: string;
  readonly args: unknown;
  readonly purpose: string;
}

export type InvokeResult =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: "no_grant" | "quorum_failed" | "quorum_denied" };

function audit(
  ctx: InvokeGateCtx,
  q: InboundInvoke,
  decision: TeamVaultDecision,
  approvers?: readonly string[],
): void {
  appendTeamVaultAudit(ctx.db, {
    peerId: q.peerId,
    entry: q.entry,
    toolId: q.toolId,
    decision,
    timestamp: (ctx.now ?? Date.now)(),
    ...(approvers === undefined ? {} : { approvers }),
  });
}

/**
 * I19 — the ONLY path that consumes a team-vault credential. identity → RBAC → quorum →
 * run-with-injected-secret. Returns only `{ result }`; the secret never enters this scope and is
 * never placed in any outbound payload. Every outcome is audited.
 */
export async function answerFederatedInvoke(
  ctx: InvokeGateCtx,
  q: InboundInvoke,
): Promise<InvokeResult> {
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    audit(ctx, q, "identity_invalid");
    return { kind: "error", error: "no_grant" }; // opaque (no identity-state leak)
  }

  const entryDef = ctx.store.getEntry(q.entry);
  if (entryDef === undefined || !ctx.store.checkGrant(q.entry, q.peerId, q.toolId)) {
    audit(ctx, q, "no_grant"); // opaque whether entry exists or grant is missing
    return { kind: "error", error: "no_grant" };
  }

  const rule = ctx.quorumFor(q.toolId);
  if (rule !== undefined) {
    const outcome = await ctx.runQuorum(rule);
    if (outcome.outcome === "denied") {
      audit(ctx, q, "quorum_denied", outcome.approvers);
      return { kind: "error", error: "quorum_denied" };
    }
    if (outcome.outcome !== "approved") {
      audit(ctx, q, "quorum_failed", outcome.approvers);
      return { kind: "error", error: "quorum_failed" };
    }
  }

  const result = await ctx.runTool({
    entry: q.entry,
    service: entryDef.service,
    toolId: q.toolId,
    args: q.args,
  });
  audit(ctx, q, "answered");
  return { kind: "ok", result };
}
