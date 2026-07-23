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

/**
 * F1: a bare `undefined` cannot distinguish "the deploy-environment gate
 * explicitly excluded this item" from "nothing in the config map claims it
 * at all" — and that ambiguity is exactly what let a gate-excluded preview
 * deployment's `undefined` get silently re-bound by the graph populator's
 * `?? stringField(row.metadata, "service")` fallback. The three cases are
 * now distinguishable:
 *   - `bound`    — a `ServiceConfig` claimed this item and it passed I-1's
 *                  deploy-environment gate (or the gate doesn't apply).
 *   - `excluded` — a `ServiceConfig` claimed this item but I-1 excluded it
 *                  (non-prod environment, or F2's no-signal fail-closed
 *                  case). The caller MUST bind nothing — never fall back.
 *   - `unknown`  — nothing in the config map claims this item. The caller
 *                  may still fall back to `metadata.service`, unchanged.
 */
export type ServiceIdentityResolution =
  | { readonly kind: "bound"; readonly serviceId: string }
  | { readonly kind: "excluded" }
  | { readonly kind: "unknown" };

export type ServiceIdentityResolver = (item: ServiceIdentityItem) => ServiceIdentityResolution;

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
 * coincidence is unaffected, and always resolves `bound` once a
 * `ServiceConfig` claims it.
 *
 * F2 DECISION (no-signal case, REVISED — was fail-open): a deployment with
 * NEITHER `metadata.environment` NOR `metadata.target` now resolves
 * `excluded`, not `bound`. The prior fail-open reasoning leaned on Vercel
 * "always" writing `target` — but this repo's own connector description
 * (`packages/mcp-connectors/vercel/nimbus.extension.json`) documents
 * `target` as `production/staging` only (no "always present" guarantee),
 * and `vercel-deployment-mapping.ts` already treats it as possibly absent
 * (`stringField(row, "target") ?? null`). If the Vercel API ever returns
 * `target: null` for a preview deploy, fail-open would filter nothing while
 * a passing test claimed it did. An unknown environment cannot be shown to
 * be production, and a false "this deploy caused that incident" edge is
 * worse than a missing one — so no signal now means no binding. This costs
 * nothing real: `deployment/annotate.ts` (the CI path) already *requires*
 * `environment` and throws without it, and Prefect's mapper
 * (`prefect-deployment-mapping.ts`) writes no key this resolver binds on at
 * all (no `repo`/`pagerduty_service_id`/`nimbus_service_id`), so its
 * deployments never reached this function either before or after.
 */
function deploymentBindingResolution(
  item: ServiceIdentityItem,
  cfg: ServiceConfig,
): ServiceIdentityResolution {
  if (item.type !== "deployment") {
    return { kind: "bound", serviceId: cfg.serviceId };
  }
  const env = deploymentEnvironment(item.metadata);
  if (env === undefined) {
    return { kind: "excluded" };
  }
  return cfg.deployEnvironments.includes(env)
    ? { kind: "bound", serviceId: cfg.serviceId }
    : { kind: "excluded" };
}

/** M-2: URN this candidate `ServiceConfig` matched, for the ambiguity warning. */
function matchingRepoUrnKey(metadata: Record<string, unknown>, cfg: ServiceConfig): string {
  const urn = cfg.repos.find((u) => repoMetadataMatchesUrn(metadata, u));
  return urn === undefined ? "?" : `${urn.provider}:${urn.providerId}`;
}

/**
 * F3: one entry per binding key that more than one `ServiceConfig` claims.
 * `winner` mirrors the deterministic pick the resolution loop below makes
 * (first by `configs` iteration order). `warned` is mutated at most once —
 * ambiguity is a static property of the config map, so the decision to
 * report it is made once per key for the resolver's whole lifetime, not
 * once per item that happens to hit it (see F3 at the call sites below).
 */
type AmbiguousBindingCandidate = {
  readonly warning: AmbiguousBindingWarning;
  warned: boolean;
};

/**
 * F3: precomputes which binding keys are ambiguous, once, from `configs`
 * alone — independent of any item. `keysFor` extracts every key a given
 * `ServiceConfig` claims (its `pagerdutyServices` list, or its `repos`
 * rendered as `${provider}:${providerId}` strings); a key claimed by more
 * than one config is ambiguous.
 */
function indexAmbiguousBindings(
  configs: ReadonlyMap<string, ServiceConfig>,
  bindingKind: AmbiguousBindingWarning["bindingKind"],
  keysFor: (cfg: ServiceConfig) => Iterable<string>,
): Map<string, AmbiguousBindingCandidate> {
  const claimantsByKey = new Map<string, ServiceConfig[]>();
  for (const cfg of configs.values()) {
    for (const key of keysFor(cfg)) {
      const claimants = claimantsByKey.get(key);
      if (claimants === undefined) {
        claimantsByKey.set(key, [cfg]);
      } else {
        claimants.push(cfg);
      }
    }
  }

  const ambiguous = new Map<string, AmbiguousBindingCandidate>();
  for (const [key, claimants] of claimantsByKey) {
    if (claimants.length > 1) {
      const winner = claimants[0] as ServiceConfig;
      ambiguous.set(key, {
        warning: {
          bindingKind,
          key,
          chosenServiceId: winner.serviceId,
          candidateServiceIds: claimants.map((c) => c.serviceId),
        },
        warned: false,
      });
    }
  }
  return ambiguous;
}

/**
 * F4: reports `candidate`'s ambiguity at most once (F3), and only for a
 * `resolution` that actually bound — an ambiguity behind a deployment that
 * I-1 excluded never produced the binding the warning would claim, so it
 * must not be reported at all (the log would otherwise assert a
 * `chosenServiceId` for a resolve that returned nothing).
 */
function reportAmbiguityIfBound(
  candidate: AmbiguousBindingCandidate | undefined,
  resolution: ServiceIdentityResolution,
  onAmbiguousBinding: AmbiguousBindingWarner | undefined,
): void {
  if (candidate === undefined || candidate.warned || resolution.kind !== "bound") {
    return;
  }
  candidate.warned = true;
  onAmbiguousBinding?.(candidate.warning);
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
 * A `deployment`-typed item additionally passes `deploymentBindingResolution`
 * against whichever `ServiceConfig` matched (I-1/F2) — a non-prod (or,
 * since F2, environment-signal-less) deployment resolves `excluded` even
 * though a config claims it, on every path.
 *
 * `onAmbiguousBinding` (M-2) fires when path 2 or 3's binding key has more
 * than one candidate `ServiceConfig` claiming it; the resolution itself
 * stays deterministic (first by `configs` iteration order, unchanged). F3:
 * the ambiguity set is computed once, in this function body, not per item —
 * so the callback fires at most once per ambiguous key for the resolver's
 * lifetime, not once per item that resolves through it. F4: it only fires
 * for a resolution that actually returned `bound`.
 *
 * Returns `{ kind: "unknown" }` when nothing in the config map claims the
 * item — the graph populator falls back to `metadata.service` for that case
 * only (today's behaviour, unchanged). `{ kind: "excluded" }` means a config
 * claimed the item but I-1/F2 excluded it: the caller must bind nothing.
 */
export function buildServiceIdentityResolver(
  configs: ReadonlyMap<string, ServiceConfig>,
  onAmbiguousBinding?: AmbiguousBindingWarner,
): ServiceIdentityResolver {
  // F3: computed once here, from `configs` alone — see `indexAmbiguousBindings`.
  const pagerdutyAmbiguity = indexAmbiguousBindings(
    configs,
    "pagerduty_service_id",
    (cfg) => cfg.pagerdutyServices,
  );
  const repoUrnAmbiguity = indexAmbiguousBindings(configs, "repo_urn", (cfg) =>
    cfg.repos.map((urn) => `${urn.provider}:${urn.providerId}`),
  );

  return (item) => {
    const nimbusServiceId = stringField(item.metadata, "nimbus_service_id");
    if (nimbusServiceId !== undefined) {
      const cfg = configs.get(nimbusServiceId);
      if (cfg !== undefined) {
        return deploymentBindingResolution(item, cfg);
      }
    }

    const pagerdutyServiceId = stringField(item.metadata, "pagerduty_service_id");
    if (pagerdutyServiceId !== undefined) {
      const claimants = [...configs.values()].filter((cfg) =>
        cfg.pagerdutyServices.includes(pagerdutyServiceId),
      );
      if (claimants.length > 0) {
        const winner = claimants[0] as ServiceConfig;
        const resolution = deploymentBindingResolution(item, winner);
        reportAmbiguityIfBound(
          pagerdutyAmbiguity.get(pagerdutyServiceId),
          resolution,
          onAmbiguousBinding,
        );
        return resolution;
      }
    }

    const repoClaimants = [...configs.values()].filter((cfg) =>
      cfg.repos.some((urn) => repoMetadataMatchesUrn(item.metadata, urn)),
    );
    if (repoClaimants.length > 0) {
      const winner = repoClaimants[0] as ServiceConfig;
      const resolution = deploymentBindingResolution(item, winner);
      const urnKey = matchingRepoUrnKey(item.metadata, winner);
      reportAmbiguityIfBound(repoUrnAmbiguity.get(urnKey), resolution, onAmbiguousBinding);
      return resolution;
    }

    return { kind: "unknown" };
  };
}
