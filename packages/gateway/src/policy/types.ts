import type { QuorumRule } from "../config/nimbus-toml.ts";

export type { QuorumRule };

export type UnmappedMode = "refuse" | "public-read";

export interface ChatopsChannelBinding {
  readonly namespace: string;
  readonly unmapped: UnmappedMode;
  readonly notify: readonly string[];
}

export interface ChatopsPolicy {
  /** channelId -> binding. */
  readonly channels: ReadonlyMap<string, ChatopsChannelBinding>;
  /** ownership glob pattern -> owner email (insertion order preserved). */
  readonly ownership: ReadonlyMap<string, string>;
}

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
  readonly chatops: ChatopsPolicy;
  /**
   * Capabilities the org has turned OFF.
   *
   * Modelled as a disabled SET rather than per-capability booleans so that resolution against the
   * local baseline is a union -- monotonic-stricter by construction (I22). With booleans,
   * `code_execution = true` would read as a grant, letting a peer-distributed policy RE-ENABLE what
   * the anchor disabled; a set makes that unrepresentable rather than merely discouraged.
   */
  readonly capabilities: { readonly disabled: readonly string[] };
}

/**
 * The Phase 14 / Spine S2 capability names an org policy may disable, via
 * `[policy.capabilities.ai_v2]`. An unrecognised name in that block is ignored rather than carried,
 * so a typo cannot masquerade as a lockoff nobody enforces.
 */
export const AI_V2_CAPABILITIES = [
  "code_execution",
  "computer_use",
  "tool_generation",
  "multimodal_input",
  "local_finetuning",
] as const;

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
