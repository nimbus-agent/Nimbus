import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";

export type TeamVaultDecision =
  | "answered"
  | "no_grant"
  | "identity_invalid"
  | "quorum_failed"
  | "quorum_denied";

/** I19 — polymorphic principal for team-vault audit entries.
 *  "peer" = an inbound federated invoke from a remote peer (the classic path).
 *  "localOperator" = the local machine owner triggering a team-credentialed sync (Wave 7b). */
export type AuditPrincipal =
  | { readonly kind: "peer"; readonly peerId: string }
  | { readonly kind: "localOperator" };

export interface TeamVaultAuditFields {
  readonly principal: AuditPrincipal;
  readonly entry: string;
  readonly toolId: string;
  readonly decision: TeamVaultDecision;
  readonly timestamp: number;
  readonly approvers?: readonly string[];
}

/** Tamper-evident audit for a team-vault invoke (answered or rejected). */
export function appendTeamVaultAudit(db: Database, f: TeamVaultAuditFields): void {
  const federationJson = JSON.stringify({
    principal: f.principal.kind,
    ...(f.principal.kind === "peer" ? { peer_id: f.principal.peerId } : {}),
    entry: f.entry,
    tool_id: f.toolId,
    decision: f.decision,
    method: "federation.invoke",
    ...(f.approvers === undefined ? {} : { approvers: f.approvers }),
  });
  appendAuditEntry(db, {
    actionType: `teamvault.invoke.${f.decision}`,
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ method: "federation.invoke", entry: f.entry, toolId: f.toolId }),
    timestamp: f.timestamp,
    federationJson,
  });
}
