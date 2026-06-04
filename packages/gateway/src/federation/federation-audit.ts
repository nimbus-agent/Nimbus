import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { FederationDecision } from "./types.ts";

export interface FederationAuditFields {
  readonly peerId: string;
  readonly namespace: string;
  readonly purpose: string;
  readonly decision: FederationDecision;
  readonly method: "federation.query" | "federation.expertise";
  readonly timestamp: number;
}

/** Append a tamper-evident audit entry for an inbound federated query (answered or rejected). */
export function appendFederationAudit(db: Database, f: FederationAuditFields): void {
  const federationJson = JSON.stringify({
    peer_id: f.peerId,
    namespace: f.namespace,
    purpose: f.purpose,
    decision: f.decision,
    method: f.method,
  });
  // actionJson intentionally repeats { method, namespace } so generic action_json
  // audit tooling sees the namespace; federationJson carries the full federation context.
  // Both are hashed into the chain, so the repetition is tamper-evident, not a divergence risk.
  appendAuditEntry(db, {
    actionType: `federation.answer.${f.decision}`,
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ method: f.method, namespace: f.namespace }),
    timestamp: f.timestamp,
    federationJson,
  });
}
