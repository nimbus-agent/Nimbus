import type { ParsedDoraRepoUrn, ServiceConfig } from "./dora-config.ts";

/**
 * The subset of an indexed item the resolver needs. Mirrors
 * `SyncContext["resolveServiceId"]`'s parameter shape (`sync/types.ts`) —
 * kept as a local type here so this module stays dependency-light and
 * trivially unit-testable in isolation from the sync layer.
 */
export type ServiceIdentityItem = {
  readonly service: string;
  readonly type: string;
  readonly metadata: Record<string, unknown>;
};

export type ServiceIdentityResolver = (item: ServiceIdentityItem) => string | undefined;

function stringField(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Matches an item's repo-shaped metadata against a `[metrics.dora.<id>]` /
 * `[ci.service.<id>]` repo URN. Mirrors `repoLikeMatchesUrn` in
 * `metrics/dora.ts`, minus its `circleci` external-id branch: this
 * resolver's item shape (`SyncContext.resolveServiceId`) carries no
 * external id, only metadata, so a circleci URN never matches here.
 */
function repoMetadataMatchesUrn(
  metadata: Record<string, unknown>,
  urn: ParsedDoraRepoUrn,
): boolean {
  switch (urn.provider) {
    case "github":
    case "bitbucket":
      return metadata["repo"] === urn.providerId;
    case "gitlab":
      return metadata["project"] === urn.providerId || metadata["repo"] === urn.providerId;
    case "jenkins":
      return metadata["jobName"] === urn.providerId;
    case "circleci":
      return false;
  }
}

/**
 * Builds a `SyncContext.resolveServiceId` resolver from the
 * `[metrics.dora.<id>]` / `[ci.service.<id>]` service-identity bindings
 * (`loadNimbusServiceConfigsFromConfigDir`, `config/nimbus-toml.ts`).
 *
 * Resolution order, first match wins:
 *   1. `metadata.nimbus_service_id` — used directly only if it names a
 *      known service (guards against a stale/foreign id passing through).
 *   2. `metadata.pagerduty_service_id` — matched against the `ServiceConfig`
 *      whose `pagerdutyServices` contains it.
 *   3. `metadata.repo` / `metadata.project` — matched against the
 *      `ServiceConfig` whose `repos` contains a matching URN.
 *
 * Returns `undefined` when nothing binds, so the graph populator falls back
 * to `metadata.service` (today's behaviour, unchanged).
 */
export function buildServiceIdentityResolver(
  configs: ReadonlyMap<string, ServiceConfig>,
): ServiceIdentityResolver {
  return (item) => {
    const nimbusServiceId = stringField(item.metadata, "nimbus_service_id");
    if (nimbusServiceId !== undefined && configs.has(nimbusServiceId)) {
      return nimbusServiceId;
    }

    const pagerdutyServiceId = stringField(item.metadata, "pagerduty_service_id");
    if (pagerdutyServiceId !== undefined) {
      for (const cfg of configs.values()) {
        if (cfg.pagerdutyServices.includes(pagerdutyServiceId)) {
          return cfg.serviceId;
        }
      }
    }

    for (const cfg of configs.values()) {
      if (cfg.repos.some((urn) => repoMetadataMatchesUrn(item.metadata, urn))) {
        return cfg.serviceId;
      }
    }

    return undefined;
  };
}
