import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";

export type TeamVaultDecision =
  | "answered"
  | "no_grant"
  | "identity_invalid"
  | "quorum_failed"
  | "quorum_denied";

export interface TeamVaultAuditFields {
  readonly peerId: string;
  readonly entry: string;
  readonly toolId: string;
  readonly decision: TeamVaultDecision;
  readonly timestamp: number;
  readonly approvers?: readonly string[];
}

/** Tamper-evident audit for an inbound team-vault invoke (answered or rejected). */
export function appendTeamVaultAudit(db: Database, f: TeamVaultAuditFields): void {
  const federationJson = JSON.stringify({
    peer_id: f.peerId,
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
