import type { PolicyState } from "../policy/types.ts";
import type {
  AuditStatus,
  ConnectorStatus,
  GatewayStatus,
  HitlStatusCounts,
  IdentityStatus,
  NamespaceStatus,
  PeerStatus,
} from "./types.ts";

export interface StatusInputs {
  policy: PolicyState;
  peers: PeerStatus[];
  connectors: ConnectorStatus[];
  namespaces: NamespaceStatus[];
  audit: AuditStatus;
  hitl: HitlStatusCounts;
  identity: IdentityStatus;
  syncFreshnessMs: number;
}

/** Pure assembler. Real readers are wired at the call site (Task 15). */
export function buildGatewayStatus(i: StatusInputs): GatewayStatus {
  return {
    policy: i.policy,
    peers: i.peers,
    connectors: i.connectors,
    namespaces: i.namespaces,
    audit: i.audit,
    hitl: i.hitl,
    identity: i.identity,
    syncFreshnessMs: i.syncFreshnessMs,
  };
}
