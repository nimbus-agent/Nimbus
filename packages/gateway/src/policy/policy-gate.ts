import type { Database } from "bun:sqlite";
import type { QuorumRule } from "../config/nimbus-toml.ts";
import { canonicalize, verifyPolicy } from "./policy-signing.ts";
import type { PersistedPolicy, PolicyStore } from "./policy-store.ts";
import { parsePolicyToml } from "./policy-toml.ts";
import type { ChatopsPolicy, OrgPolicy, PolicyState } from "./types.ts";

/** The local config/default floor that policy can only tighten, never loosen. */
export interface LocalBaseline {
  readonly retentionDays: number;
  readonly hitlRequired: ReadonlySet<string>;
  readonly quorum: ReadonlyMap<string, QuorumRule>;
}

/** The enforced view — the ONLY thing enforcement sites read (I22). */
export interface EnforcedPolicy {
  readonly connectorAllow?: readonly string[];
  readonly retentionDays: number;
  readonly hitlRequired: ReadonlySet<string>;
  readonly quorum: ReadonlyMap<string, QuorumRule>;
  readonly auditShipTo?: string;
  readonly auditShipFormat?: string;
  readonly chatops: ChatopsPolicy;
}

/** Pure monotonic-stricter resolution against the local baseline. */
export function computeEnforced(policy: OrgPolicy, base: LocalBaseline): EnforcedPolicy {
  const hitlRequired = new Set<string>(base.hitlRequired);
  for (const a of policy.hitl.require) hitlRequired.add(a);

  const quorum = new Map<string, QuorumRule>(base.quorum);
  for (const [id, pol] of policy.hitl.quorum) {
    const local = quorum.get(id);
    const approvers = Math.max(local?.approvers ?? 0, pol.approvers);
    // Stricter wins for the window too: a SHORTER window is harder to satisfy
    // (quorum is fail-closed — expiry denies), so take the min of the defined
    // positive windows. Policy can only tighten, never lengthen, the window (I22).
    const windows = [
      local?.windowSeconds,
      pol.windowSeconds > 0 ? pol.windowSeconds : undefined,
    ].filter((w): w is number => w !== undefined && w > 0);
    const windowSeconds = windows.length > 0 ? Math.min(...windows) : 0;
    quorum.set(id, { approvers, windowSeconds });
  }

  return {
    ...(policy.connectors.allow === undefined ? {} : { connectorAllow: policy.connectors.allow }),
    retentionDays: Math.max(base.retentionDays, policy.retention.minDays),
    hitlRequired,
    quorum,
    ...(policy.audit.shipTo === undefined ? {} : { auditShipTo: policy.audit.shipTo }),
    ...(policy.audit.shipFormat === undefined ? {} : { auditShipFormat: policy.audit.shipFormat }),
    chatops: policy.chatops,
  };
}

/**
 * Verify a candidate {toml, sig} against the pinned pubkey. Returns the parsed
 * OrgPolicy ONLY if the signature is valid; otherwise null (caller falls back to
 * last-valid — fail-closed).
 */
export function verifyCandidate(toml: string, sig: string, pinnedPubkey: string): OrgPolicy | null {
  if (!verifyPolicy(toml, sig, pinnedPubkey)) return null;
  // Parse the SAME canonical bytes the signature was verified over, never the raw input,
  // so a verify/parse representation drift can never admit a different policy.
  return parsePolicyToml(canonicalize(toml));
}

/**
 * The single gate enforcement consults. Holds the active OrgPolicy (or none) and
 * the local baseline; exposes EnforcedPolicy + status. Unverified policy never
 * reaches here — only verifyCandidate-approved policies are set.
 */
export class PolicyGate {
  private active: OrgPolicy | undefined;
  private state: PolicyState = { signatureValid: false, pendingRestart: false, source: "none" };

  /** Copy the baseline + its collections so external mutation can never alter enforcement. */
  private static cloneBaseline(base: LocalBaseline): LocalBaseline {
    return {
      retentionDays: base.retentionDays,
      hitlRequired: new Set(base.hitlRequired),
      quorum: new Map(base.quorum),
    };
  }

  constructor(
    private readonly store: PolicyStore,
    private baseline: LocalBaseline,
  ) {
    this.baseline = PolicyGate.cloneBaseline(baseline);
    this.rehydrate();
  }

  private rehydrate(): void {
    const persisted = this.store.load();
    const pinned = this.store.getAnchorPubkey();
    if (persisted === undefined || pinned === undefined) return;
    const parsed = verifyCandidate(persisted.toml, persisted.sig, pinned);
    if (parsed === null) return; // persisted copy tampered on disk — stay ungoverned
    this.active = parsed;
    this.state = {
      org: persisted.org,
      version: persisted.version,
      signatureValid: true,
      lastFetchedMs: persisted.fetchedAt,
      pendingRestart: false,
      source: persisted.source === "none" ? "peer" : persisted.source,
    };
  }

  /** Apply a freshly-verified policy (already signature-checked). */
  applyVerified(policy: OrgPolicy, persisted: PersistedPolicy, pendingRestart: boolean): void {
    this.active = policy;
    this.state = {
      org: persisted.org,
      version: persisted.version,
      signatureValid: true,
      lastFetchedMs: persisted.fetchedAt,
      pendingRestart,
      source: persisted.source === "none" ? "peer" : persisted.source,
    };
  }

  setBaseline(base: LocalBaseline): void {
    this.baseline = PolicyGate.cloneBaseline(base);
  }

  enforced(): EnforcedPolicy {
    if (this.active === undefined) {
      return {
        retentionDays: this.baseline.retentionDays,
        hitlRequired: new Set(this.baseline.hitlRequired),
        quorum: new Map(this.baseline.quorum),
        chatops: { channels: new Map(), ownership: new Map() },
      };
    }
    return computeEnforced(this.active, this.baseline);
  }

  status(): PolicyState {
    return this.state;
  }
}

/** Build a PolicyGate bound to a db (helper for assembly). */
export function buildPolicyGate(
  _db: Database,
  store: PolicyStore,
  baseline: LocalBaseline,
): PolicyGate {
  return new PolicyGate(store, baseline);
}
