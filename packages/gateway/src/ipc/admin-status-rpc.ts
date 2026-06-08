import type { PolicyState } from "../policy/types.ts";
import { buildGatewayStatus } from "../status/gateway-status.ts";
import type {
  AuditStatus,
  ConnectorStatus,
  GatewayStatus,
  HitlStatusCounts,
  IdentityStatus,
  NamespaceStatus,
  PeerStatus,
} from "../status/types.ts";

/**
 * The per-field readers behind the observability snapshot. Each is a cheap, synchronous accessor —
 * the snapshot is assembled on demand for `admin.status`, `GET /v1/admin/status`, and `GET /metrics`.
 * Wired to real subsystem state in `assemblePlatformServices` (Task 15); conservative defaults stand
 * in for fields with no cheap accessor.
 */
export interface StatusReaders {
  policyState: () => PolicyState;
  peers: () => PeerStatus[];
  connectors: () => ConnectorStatus[];
  namespaces: () => NamespaceStatus[];
  audit: () => AuditStatus;
  hitl: () => HitlStatusCounts;
  identity: () => IdentityStatus;
  syncFreshnessMs: () => number;
}

export function assembleStatusInputs(r: StatusReaders) {
  return {
    policy: r.policyState(),
    peers: r.peers(),
    connectors: r.connectors(),
    namespaces: r.namespaces(),
    audit: r.audit(),
    hitl: r.hitl(),
    identity: r.identity(),
    syncFreshnessMs: r.syncFreshnessMs(),
  };
}

export function buildStatus(r: StatusReaders): GatewayStatus {
  return buildGatewayStatus(assembleStatusInputs(r));
}
