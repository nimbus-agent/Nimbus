import type { EnforcedPolicy } from "./policy-gate.ts";

export interface AllowlistPartition {
  readonly permitted: readonly string[];
  readonly blocked: readonly string[];
}

/** Split configured connector ids by the policy allowlist. undefined allow = unrestricted. */
export function partitionByAllowlist(
  configured: readonly string[],
  allow: readonly string[] | undefined,
): AllowlistPartition {
  if (allow === undefined) return { permitted: configured, blocked: [] };
  const permitted: string[] = [];
  const blocked: string[] = [];
  for (const id of configured) (allow.includes(id) ? permitted : blocked).push(id);
  return { permitted, blocked };
}

/**
 * The connector-allowlist decision the gateway hands every consumer of
 * `EnforcedPolicy.connectorAllow` (I22): the mesh's tool filter, sync registration at boot, the
 * admin status report and the connector-write transport. The predicate reads `gate.enforced()` on
 * EVERY call, never a value captured when it was built, so a newly verified bundle reaches the
 * next call without a restart. Sync registration calls it only at boot, so sync sees a new bundle
 * only after one. With no `[policy.connectors] allow` (an ungoverned gateway, or a policy that sets
 * none) every connector is allowed.
 */
export function connectorAllowPredicate(gate: {
  enforced(): Pick<EnforcedPolicy, "connectorAllow">;
}): (serviceId: string) => boolean {
  return (serviceId) => {
    const allow = gate.enforced().connectorAllow;
    return allow === undefined || allow.includes(serviceId);
  };
}
