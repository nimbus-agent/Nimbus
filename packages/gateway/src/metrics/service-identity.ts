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

/** M-2: reported when two `ServiceConfig`s both claim the same binding key —
 * the resolver still picks deterministically (first by config-map iteration
 * order, same as before), this only makes the ambiguity observable. */
export type AmbiguousBindingWarning = {
  readonly bindingKind: "pagerduty_service_id" | "repo_urn";
  readonly key: string;
  readonly chosenServiceId: string;
  readonly candidateServiceIds: readonly string[];
};

export type AmbiguousBindingWarner = (warning: AmbiguousBindingWarning) => void;

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
 * Vercel's git-integration deployments write `target: "production" | "preview"`
 * (`connectors/vercel-deployment-mapping.ts`). Everywhere else that speaks an
 * environment name — `ServiceConfig.deployEnvironments`, and the explicit
 * `metadata.environment` `deployment/annotate.ts` writes — uses the canonical
 * `deployEnvironments` vocabulary (default `["prod"]`). This is the one alias
 * needed to bridge the two.
 */
const DEPLOY_TARGET_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  production: "prod",
});

function normalizeDeployEnvironment(raw: string): string {
  return DEPLOY_TARGET_ALIASES[raw] ?? raw;
}

/**
 * Best-effort environment signal for a deployment item: the canonical
 * `metadata.environment` (`deployment/annotate.ts`) takes precedence,
 * falling back to Vercel's `metadata.target`. `undefined` means the item
 * carries no environment signal at all.
 */
function deploymentEnvironment(meta: Record<string, unknown>): string | undefined {
  const raw = stringField(meta, "environment") ?? stringField(meta, "target");
  return raw === undefined ? undefined : normalizeDeployEnvironment(raw);
}

/**
 * I-1: a deployment with an explicit non-prod environment signal (e.g. a
 * Vercel preview, created on every push for a git-integrated project) must
 * not bind to a service identity at all — binding it would let
 * `syncTimelineEventGraph` correlate it against every incident in the
 * 2-hour window, asserting a causal "this deploy caused that incident" edge
 * for a deploy that never reached the target environment. Previews
 * numerically dominate prod deploys, so left unfiltered they drown out the
 * correlations that matter.
 *
 * Only `deployment`-typed items are gated — an `incident` (or any other
 * item type) carrying `metadata.target`/`metadata.environment` by
 * coincidence is unaffected.
 *
 * DECISION (I-1, no-signal case): a deployment with NEITHER
 * `metadata.environment` NOR `metadata.target` is bound anyway (fail-open),
 * not excluded. Today's only two deployment sources are
 * `deployment/annotate.ts` (which always sets `metadata.environment`, and is
 * itself already DORA-gated by `deployEnvironments` before annotation) and
 * Vercel (`metadata.target`, always present in the git-integration payload
 * `mapVercelDeploymentToItem` maps). A future deployment connector that
 * emits neither key is genuinely unknown, not known-and-excluded — treating
 * "no signal" the same as "excluded" would silently drop ALL correlation for
 * that connector's deploys, a strictly worse failure mode than the narrow,
 * fixable over-emission this filter targets.
 */
function deploymentEnvironmentAllowed(item: ServiceIdentityItem, cfg: ServiceConfig): boolean {
  if (item.type !== "deployment") return true;
  const env = deploymentEnvironment(item.metadata);
  if (env === undefined) return true;
  return cfg.deployEnvironments.includes(env);
}

/** M-2: URN this candidate `ServiceConfig` matched, for the ambiguity warning. */
function matchingRepoUrnKey(metadata: Record<string, unknown>, cfg: ServiceConfig): string {
  const urn = cfg.repos.find((u) => repoMetadataMatchesUrn(metadata, u));
  return urn === undefined ? "?" : `${urn.provider}:${urn.providerId}`;
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
 * A `deployment`-typed item additionally passes `deploymentEnvironmentAllowed`
 * against whichever `ServiceConfig` matched (I-1) — a non-prod deployment
 * resolves to `undefined` even though a config claims it, on every path.
 *
 * `onAmbiguousBinding` (M-2) fires when path 2 or 3 has more than one
 * candidate `ServiceConfig` claiming the same key; the resolution itself
 * stays deterministic (first by `configs` iteration order, unchanged).
 *
 * Returns `undefined` when nothing binds, so the graph populator falls back
 * to `metadata.service` (today's behaviour, unchanged).
 */
export function buildServiceIdentityResolver(
  configs: ReadonlyMap<string, ServiceConfig>,
  onAmbiguousBinding?: AmbiguousBindingWarner,
): ServiceIdentityResolver {
  return (item) => {
    const nimbusServiceId = stringField(item.metadata, "nimbus_service_id");
    if (nimbusServiceId !== undefined) {
      const cfg = configs.get(nimbusServiceId);
      if (cfg !== undefined) {
        return deploymentEnvironmentAllowed(item, cfg) ? nimbusServiceId : undefined;
      }
    }

    const pagerdutyServiceId = stringField(item.metadata, "pagerduty_service_id");
    if (pagerdutyServiceId !== undefined) {
      const claimants = [...configs.values()].filter((cfg) =>
        cfg.pagerdutyServices.includes(pagerdutyServiceId),
      );
      if (claimants.length > 0) {
        const winner = claimants[0] as ServiceConfig;
        if (claimants.length > 1) {
          onAmbiguousBinding?.({
            bindingKind: "pagerduty_service_id",
            key: pagerdutyServiceId,
            chosenServiceId: winner.serviceId,
            candidateServiceIds: claimants.map((c) => c.serviceId),
          });
        }
        return deploymentEnvironmentAllowed(item, winner) ? winner.serviceId : undefined;
      }
    }

    const repoClaimants = [...configs.values()].filter((cfg) =>
      cfg.repos.some((urn) => repoMetadataMatchesUrn(item.metadata, urn)),
    );
    if (repoClaimants.length > 0) {
      const winner = repoClaimants[0] as ServiceConfig;
      if (repoClaimants.length > 1) {
        onAmbiguousBinding?.({
          bindingKind: "repo_urn",
          key: matchingRepoUrnKey(item.metadata, winner),
          chosenServiceId: winner.serviceId,
          candidateServiceIds: repoClaimants.map((c) => c.serviceId),
        });
      }
      return deploymentEnvironmentAllowed(item, winner) ? winner.serviceId : undefined;
    }

    return undefined;
  };
}
