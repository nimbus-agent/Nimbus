import type { Database } from "bun:sqlite";

import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import { type ConnectorSecretKeyOf, readConnectorSecret } from "../connectors/connector-vault.ts";
import type { ResolveServiceId } from "../graph/graph-populator.ts";
import { type BodyRow, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * What a syncable may reach, in place of the raw `vault` and `db` handles it holds today.
 *
 * Each capability is bound to ONE service by the gateway. The service id is never a parameter the
 * caller supplies — a caller-supplied id would make `getSecret` a vault handle with extra steps,
 * which is the thing this exists to prevent.
 */

/**
 * The ONLY cross-service credential reads in the codebase, enumerated rather than inferred.
 *
 * Four connectors legitimately authenticate with a SHARED credential family: BigQuery, Cloud
 * Logging and Vertex AI all use one `gcp.*` service account, and GitHub Actions uses the same
 * `github.pat` as the GitHub connector. `isConnectorConfigured`'s DERIVED_CONFIGURED_CHECKS already
 * encodes the same relationships for I29's egress gating.
 *
 * Scoping `getSecret` to the calling service alone would have broken all four. Granting them a
 * blanket vault handle would have un-done the narrowing. This is the third option: a named,
 * checked grant, so a NEW cross-service read is a deliberate edit here rather than an accident.
 */
export const SHARED_CREDENTIAL_GRANTS = {
  bigquery: ["gcp"],
  cloud_logging: ["gcp"],
  vertex_ai: ["gcp"],
  github_actions: ["github"],
} as const satisfies Partial<Record<ConnectorServiceId, readonly ConnectorServiceId[]>>;

function grantsFor(serviceId: ConnectorServiceId): readonly ConnectorServiceId[] {
  return (
    (
      SHARED_CREDENTIAL_GRANTS as Partial<Record<ConnectorServiceId, readonly ConnectorServiceId[]>>
    )[serviceId] ?? []
  );
}

export interface SyncCapabilities<S extends ConnectorServiceId = ConnectorServiceId> {
  /**
   * Resolves `<serviceId>.<keyName>` against the vault. A syncable cannot name another service's
   * key: the prefix is applied here, not by the caller. The key TYPE stays service-specific, so
   * the compile-time checking `readConnectorSecret` gives today is preserved rather than widened
   * to `string`.
   */
  getSecret(keyName: ConnectorSecretKeyOf<S>): Promise<string | null>;
  /**
   * Reads a SHARED credential family — `gcp.*` for the three GCP connectors, `github.*` for GitHub
   * Actions. Throws when the bound service has no grant for that family, so an ungranted
   * cross-service read fails loudly at the call rather than silently returning null and looking
   * like an unconfigured connector.
   */
  getSharedSecret<F extends ConnectorServiceId>(
    family: F,
    keyName: ConnectorSecretKeyOf<F>,
  ): Promise<string | null>;
  /** The V48/V49 body-depth chokepoint, unmoved — this only routes to it. */
  upsertItem(row: BodyRow): void;
  /** SYNCHRONOUS, and returns the id: callers set it as `authorId` on the item they build. */
  resolvePerson(hints: PersonSyncHints): string | null;
}

/**
 * The gateway-side pieces a capability set closes over. `depth` is per-run, which is why
 * capabilities are built in `scheduler.ts` `runJob` rather than once at assembly: that is the first
 * point that knows both the service id and the run's resolved index depth.
 */
export interface SyncCapabilityDeps {
  vault: NimbusVault;
  db: Database;
  depth: "metadata_only" | "summary" | "full";
  resolveServiceId?: ResolveServiceId;
  scheduleItemEmbedding?: (itemId: string) => void;
}

export function buildSyncCapabilities<S extends ConnectorServiceId>(
  deps: SyncCapabilityDeps,
  serviceId: S,
): SyncCapabilities<S> {
  return {
    getSecret: (keyName) => readConnectorSecret(deps.vault, serviceId, keyName),
    getSharedSecret: (family, keyName) => {
      if (!grantsFor(serviceId).includes(family)) {
        throw new Error(
          `${serviceId} has no shared-credential grant for "${family}". Add one to ` +
            "SHARED_CREDENTIAL_GRANTS in sync/sync-capabilities.ts if that is intended.",
        );
      }
      return readConnectorSecret(deps.vault, family, keyName);
    },
    upsertItem: (row) => {
      upsertIndexedItemForSync(deps, row);
    },
    resolvePerson: (hints) => resolvePersonForSync(deps.db, hints),
  };
}

/**
 * Capabilities for a context that is NOT bound to a service — `platform/assemble.ts`'s shared
 * `syncBase`, which every connector inherits from and which therefore cannot know whose secrets to
 * resolve.
 *
 * They throw rather than being absent. An optional capability makes a missed binding a silent
 * `undefined` at runtime — the syncable reads no secret, writes no item, and reports success. A
 * throwing one names the mistake at the moment it is made. Fail-loud beats fail-open for something
 * whose whole job is to be the only way to reach a credential.
 */
export function unboundSyncCapabilities(): SyncCapabilities {
  const refuse = (what: string): never => {
    throw new Error(
      `${what} was called on an unbound SyncContext. Capabilities bind per service in ` +
        "sync/scheduler.ts contextForService(); the shared context from assemble.ts cannot know " +
        "which connector is asking.",
    );
  };
  return {
    getSecret: () => refuse("getSecret"),
    getSharedSecret: () => refuse("getSharedSecret"),
    upsertItem: () => refuse("upsertItem"),
    resolvePerson: () => refuse("resolvePerson"),
  };
}
