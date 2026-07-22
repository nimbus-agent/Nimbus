// Canonical definition now lives in @nimbus-dev/sdk (GhostBrief depends on it).
import type { ExpertiseRank } from "@nimbus-dev/sdk";

export type FederationRole = "owner" | "editor" | "viewer";

export type FilterKind = "service" | "type" | "tag";

export interface NamespaceFilter {
  readonly kind: FilterKind;
  readonly value: string;
}

export interface NamespaceDefinition {
  readonly namespaceId: string;
  readonly name: string;
  readonly ownerSelf: boolean;
  readonly createdAt: number;
  readonly filters: readonly NamespaceFilter[];
}

export interface NamespaceGrant {
  readonly namespaceId: string;
  readonly peerId: string;
  readonly role: FederationRole;
  readonly standingConsent: boolean;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/** Inbound, over-the-wire request shape (validated from `unknown`). */
export interface FederatedQueryRequest {
  readonly namespace: string;
  readonly purpose: string;
  readonly types?: readonly string[];
  readonly limit?: number;
}

/**
 * The ONLY item fields ever exposed over federation. Deliberately excludes
 * `metadata` (the raw_meta-equivalent), `author_id`, `external_id`. (Leak-proof contract.)
 */
export interface FederatedItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly snippet: string; // from item.body_preview, truncated
  readonly modifiedAt: number;
}

export interface FederatedQueryResponse {
  readonly items: readonly FederatedItem[];
}

export type FederationDecision =
  | "answered"
  | "no_grant"
  | "not_paired"
  | "namespace_unknown"
  | "timeout"
  | "consent_denied"
  | "identity_invalid";

export type { ExpertiseRank };

export interface ExpertiseRequest {
  readonly query: string;
  readonly purpose: string;
}

export interface ExpertiseResponse {
  readonly rank: ExpertiseRank;
}

/** Over-the-wire error codes returned to the requesting peer (no leak of undeclared types). */
export type FederationWireError =
  | "not_paired"
  | "no_grant"
  | "namespace_unknown"
  | "timeout_waiting_for_consent"
  | "consent_denied";
