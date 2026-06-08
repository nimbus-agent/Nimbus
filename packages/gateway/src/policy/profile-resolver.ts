import type { EnforcedPolicy } from "./policy-gate.ts";

export interface ProfileConfig {
  readonly enabledConnectors: readonly string[];
  readonly retentionDays: number;
}

export interface EffectiveConfig {
  readonly enabledConnectors: readonly string[];
  readonly retentionDays: number;
}

/** Policy is a hard outer bound; profile may be stricter, never looser. */
export function resolveEffectiveConfig(
  profile: ProfileConfig,
  policy: EnforcedPolicy,
): EffectiveConfig {
  const allow = policy.connectorAllow;
  const enabledConnectors =
    allow === undefined
      ? profile.enabledConnectors
      : profile.enabledConnectors.filter((c) => allow.includes(c));
  return {
    enabledConnectors,
    retentionDays: Math.max(profile.retentionDays, policy.retentionDays),
  };
}
