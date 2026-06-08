import type { PolicyState } from "../policy/types.ts";

export interface PeerStatus {
  peerId: string;
  reachable: boolean;
  lastSeenMs?: number;
}

export interface ConnectorStatus {
  id: string;
  enabled: boolean;
  blockedByPolicy: boolean;
  health: string;
  lastSyncMs?: number;
}

export interface NamespaceStatus {
  name: string;
  subscribers: number;
  lastPropagateMs?: number;
}

export interface AuditStatus {
  chainLength: number;
  lastHash: string;
  appendRate1h: number;
}

export interface HitlStatusCounts {
  pendingApprovals: number;
  pendingQuorum: number;
}

export interface IdentityStatus {
  operatorValid: boolean;
  externalId?: string;
}

export interface GatewayStatus {
  policy: PolicyState;
  peers: PeerStatus[];
  connectors: ConnectorStatus[];
  namespaces: NamespaceStatus[];
  audit: AuditStatus;
  hitl: HitlStatusCounts;
  identity: IdentityStatus;
  syncFreshnessMs: number;
}
