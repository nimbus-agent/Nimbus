// packages/gateway/src/sync/connector-configured.ts

import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Whether `serviceId` has at least one non-blank Vault secret among the keys
 * `connector-secrets-manifest.ts` lists for it — the same manifest `sync/fetch-host-boundary.ts`
 * uses to decide whether a service is fetchable, reused here to decide whether a scheduled sync
 * is worth running AND worth ledgering (I29 Critical 1).
 *
 * Executed failure this closes: `platform/assemble-sync-registrations.ts` registers ~90 cloud
 * syncables with NO credential gate, and each one's `sync()` short-circuits to `syncNoopResult`
 * when unconfigured — without touching the network. `sync/scheduler.ts`'s `runJob` used to append
 * a `sync` egress row unconditionally before EVERY run, so an empty Vault with N cloud connectors
 * registered produced N fabricated "authorized" rows per run, with zero outbound requests.
 *
 * Deliberately permissive — ANY key present, not ALL — for two reasons:
 *   1. A manifest with an EMPTY key list (an OAuth-managed connector like `google_drive`/`gmail`,
 *      whose credential lives outside this Vault's per-connector namespace, or a service not
 *      present in the manifest at all) has no vault-derived signal to check at all, so it is
 *      treated as configured — this function exists to catch the concrete, provable "zero
 *      configured, zero requests" case, not to become a universal readiness probe for every
 *      connector's auth strategy.
 *   2. Several manifests list keys that are alternates (Snowflake's OAuth-token-or-key-pair-JWT)
 *      or auxiliary/optional (`aws.profile`, `gcp.region`). Requiring every key would
 *      false-negative (skip) a connector that IS configured under an alternate credential shape.
 *      The cost of that stricter rule — a silently skipped sync — is worse than this rule's cost:
 *      still running `connector.sync()` against a partially-configured service, which each
 *      connector already handles by no-op'ing internally (see `sync/scheduler.ts`'s `runJob`,
 *      the sole caller, for why that no-op is not itself an outbound call worth gating further).
 */
export async function isConnectorConfigured(
  vault: NimbusVault,
  serviceId: string,
): Promise<boolean> {
  const keys = Object.hasOwn(CONNECTOR_VAULT_SECRET_KEYS, serviceId)
    ? (CONNECTOR_VAULT_SECRET_KEYS as Record<string, readonly string[]>)[serviceId]
    : undefined;
  if (keys === undefined || keys.length === 0) {
    return true;
  }
  for (const key of keys) {
    const value = await vault.get(key);
    if (value !== null && value.trim() !== "") {
      return true;
    }
  }
  return false;
}
