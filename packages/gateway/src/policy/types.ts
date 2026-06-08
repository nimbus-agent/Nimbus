import type { QuorumRule } from "../config/nimbus-toml.ts";

export type { QuorumRule };

/** The parsed org policy (anchor-authored). Optional fields = "no constraint". */
export interface OrgPolicy {
  readonly version: number;
  readonly org: string;
  readonly issuedAt?: string;
  readonly connectors: { readonly allow?: readonly string[] };
  readonly retention: { readonly minDays: number };
  readonly hitl: {
    readonly require: readonly string[];
    readonly quorum: ReadonlyMap<string, QuorumRule>;
  };
  readonly audit: { readonly shipTo?: string; readonly shipFormat?: string };
}

/** Where a persisted policy came from. */
export type PolicySource = "anchor" | "peer" | "none";

/** Runtime policy status for the observability snapshot. */
export interface PolicyState {
  readonly org?: string;
  readonly version?: number;
  readonly signatureValid: boolean;
  readonly lastFetchedMs?: number;
  readonly pendingRestart: boolean;
  readonly source: PolicySource;
}
