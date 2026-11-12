import { matchesDataModelGlob } from "./data-model-glob.ts";
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
  readonly bindingKind:
    | "pagerduty_service_id"
    | "repo_urn"
    | "jsm_alert_tag"
    | "sentry_project"
    | "data_model_glob";
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
 * `metrics/dora.ts` for `repo`-shaped URNs, minus that function's `project` / `jobName`
 * arms (they read `ci_run` rows, which GitLab and Jenkins write; this resolver binds
 * deployments and PRs, and no writer there records either) and its `circleci` external-id branch: this
 * resolver's item shape (`SyncContext.resolveServiceId`) carries no
 * external id, only metadata, so a circleci URN never matches here.
 */
// lane-census: scope=deployment,incident,pr
function repoMetadataMatchesUrn(
  metadata: Record<string, unknown>,
  urn: ParsedDoraRepoUrn,
): boolean {
  switch (urn.provider) {
    case "github":
    case "bitbucket":
      return metadata["repo"] === urn.providerId;
    case "gitlab":
      // No deployment writer records a GitLab project id: annotated deployments bind through
      // `nimbus_service_id`; Vercel and premortem's synthetic row carry `repo`.
      return metadata["repo"] === urn.providerId;
    case "jenkins":
    // No deployment writer records a Jenkins job name (annotated deployments bind through
    // `nimbus_service_id`), so a job-name match could never fire.
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
 * "always" writing `target` — but the Vercel connector's own description
 * (`connectors/vercel/nimbus.extension.json` in `@nimbus-dev/connectors`)
 * documents `target` as `production/staging` only (no "always present" guarantee),
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
 * Phase 10 IC2: items bound by the incident-engine binding keys instead of a repo or a PagerDuty id.
 * Each rule is keyed on `(service, type)` so a stray `tags` or `project` key on an unrelated item (a Prefect
 * deployment carries `tags`) never binds, and `unknown` is the answer when nothing claims the item (the
 * graph populator then falls back to `metadata.service`, which these items do not carry).
 */
type IncidentBindingIndex = {
  /** lower-cased alert tag -> claimant configs, in config order (each config once). */
  readonly tags: ReadonlyMap<string, readonly ServiceConfig[]>;
  readonly projects: ReadonlyMap<string, readonly ServiceConfig[]>;
  readonly configs: readonly ServiceConfig[];
};

function indexClaimants(
  configs: readonly ServiceConfig[],
  keysFor: (cfg: ServiceConfig) => readonly string[],
): Map<string, ServiceConfig[]> {
  const out = new Map<string, ServiceConfig[]>();
  for (const cfg of configs) {
    for (const key of new Set(keysFor(cfg))) {
      const claimants = out.get(key);
      if (claimants === undefined) out.set(key, [cfg]);
      else claimants.push(cfg);
    }
  }
  return out;
}

function buildIncidentBindingIndex(
  configs: ReadonlyMap<string, ServiceConfig>,
): IncidentBindingIndex {
  const all = [...configs.values()];
  return {
    tags: indexClaimants(all, (cfg) => cfg.jsmAlertTags.map((t) => t.trim().toLowerCase())),
    projects: indexClaimants(all, (cfg) => cfg.sentryProjects),
    configs: all,
  };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The claimants of an item through the binding keys, or null when the item is not of a bound kind. */
type BindingClaim =
  | {
      readonly kind: "exact";
      readonly bindingKind: AmbiguousBindingWarning["bindingKind"];
      readonly key: string;
      readonly claimants: readonly ServiceConfig[];
    }
  | {
      readonly kind: "glob";
      readonly claimants: readonly ServiceConfig[];
      readonly keys: readonly string[];
    }
  | null;

// lane-census: scope=alert service=jira
function alertTagClaim(index: IncidentBindingIndex, item: ServiceIdentityItem): BindingClaim {
  for (const tag of stringList(item.metadata["tags"])) {
    const key = tag.trim().toLowerCase();
    const claimants = index.tags.get(key);
    if (claimants !== undefined) {
      return { kind: "exact", bindingKind: "jsm_alert_tag", key, claimants };
    }
  }
  return null;
}

// lane-census: scope=error_issue service=sentry
function sentryProjectClaim(index: IncidentBindingIndex, item: ServiceIdentityItem): BindingClaim {
  const raw = item.metadata["project"];
  const project = typeof raw === "string" ? raw : undefined;
  const claimants = project === undefined ? undefined : index.projects.get(project);
  return project === undefined || claimants === undefined
    ? null
    : { kind: "exact", bindingKind: "sentry_project", key: project, claimants };
}

// lane-census: scope=data_quality_test service=montecarlo,bigeye
function dataModelClaim(index: IncidentBindingIndex, item: ServiceIdentityItem): BindingClaim {
  const keys = stringList(item.metadata["monitoredDataModelKeys"]);
  const claimants = index.configs.filter((cfg) =>
    keys.some((k) => cfg.dataModels.some((g) => matchesDataModelGlob(g, k))),
  );
  return claimants.length === 0 ? null : { kind: "glob", claimants, keys };
}

function incidentBindingClaim(
  index: IncidentBindingIndex,
  item: ServiceIdentityItem,
): BindingClaim {
  if (item.service === "jira" && item.type === "alert") return alertTagClaim(index, item);
  if (item.service === "sentry" && item.type === "error_issue") {
    return sentryProjectClaim(index, item);
  }
  const isDataQuality = item.service === "montecarlo" || item.service === "bigeye";
  return isDataQuality && item.type === "data_quality_test" ? dataModelClaim(index, item) : null;
}

/**
 * Reports the ambiguity of a binding-key claim at most once per key for the resolver's lifetime. Tags and
 * slugs are exact keys, so their ambiguity is the claimant count; a glob overlap cannot be precomputed, so
 * it is judged per matched model key as items arrive.
 */
function reportBindingAmbiguity(
  claim: NonNullable<BindingClaim>,
  index: IncidentBindingIndex,
  warned: Set<string>,
  onAmbiguousBinding: AmbiguousBindingWarner | undefined,
): void {
  if (onAmbiguousBinding === undefined) return;
  const report = (
    bindingKind: AmbiguousBindingWarning["bindingKind"],
    key: string,
    claimants: readonly ServiceConfig[],
  ): void => {
    const id = `${bindingKind}:${key}`;
    if (claimants.length < 2 || warned.has(id)) return;
    warned.add(id);
    onAmbiguousBinding({
      bindingKind,
      key,
      chosenServiceId: (claimants[0] as ServiceConfig).serviceId,
      candidateServiceIds: claimants.map((c) => c.serviceId),
    });
  };
  if (claim.kind === "exact") {
    report(claim.bindingKind, claim.key, claim.claimants);
    return;
  }
  for (const key of claim.keys) {
    const matching = index.configs.filter((cfg) =>
      cfg.dataModels.some((g) => matchesDataModelGlob(g, key)),
    );
    report("data_model_glob", key, matching);
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
 *   3. `metadata.repo` — matched against the
 *      `ServiceConfig` whose `repos` contains a matching URN.
 *   4. (Phase 10 IC2) the incident-engine binding keys, keyed on `(service, type)`: a `jira:alert`'s
 *      `tags` against `jsmAlertTags`, a `sentry:error_issue`'s `project` against `sentryProjects`, and a
 *      Monte Carlo or Bigeye `data_quality_test`'s `monitoredDataModelKeys` against `dataModels` globs.
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

  const bindingIndex = buildIncidentBindingIndex(configs);
  const warnedBindings = new Set<string>();

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

    // 4. (IC2) the incident-engine binding keys, keyed on (service, type); only reached when nothing above
    // claimed the item, so no existing resolution changes.
    const claim = incidentBindingClaim(bindingIndex, item);
    if (claim !== null) {
      reportBindingAmbiguity(claim, bindingIndex, warnedBindings, onAmbiguousBinding);
      return { kind: "bound", serviceId: (claim.claimants[0] as ServiceConfig).serviceId };
    }

    return { kind: "unknown" };
  };
}

/**
 * Which services claim a given repo URN, in config order.
 *
 * `serviceId` is the FIRST claimant and `candidateServiceIds` is every one of them, so a caller
 * can tell a sole claim from a contested one. Both are needed: the first-claimant pick keeps this
 * route agreeing with the binding the rest of the DORA pipeline already made for the same repo
 * (M-2 above, and `AmbiguousBindingWarning`'s `chosenServiceId`/`candidateServiceIds` pair), while
 * the full list is the only thing on the wire that says the pick was contested at all — a caller
 * about to gate a deployment on the answer cannot see the stderr warning the resolver emits.
 *
 * This is deliberately NOT a third copy of `repoMetadataMatchesUrn` / `repoLikeMatchesUrn`, and it
 * needs no refactor of either. Those two answer "does this INDEXED ITEM belong to this service",
 * matching heterogeneous item metadata (`repo` / `project` / `jobName` / an external id) against a
 * config URN. This answers a different question — "does this CONFIG URN name this service" — where
 * both sides are config vocabulary produced by the same `parseDoraRepoUrn`, so the comparison is
 * exact and provider-specific metadata rules never enter. That is also why `circleci` resolves
 * here while `repoMetadataMatchesUrn` returns `false` for it: that arm is `false` because an
 * indexed item carries no external id, which is a fact about items, not about URNs.
 */
export type RepoUrnResolution = {
  readonly serviceId: string | null;
  readonly candidateServiceIds: readonly string[];
};

export function resolveServicesByRepoUrn(
  configs: ReadonlyMap<string, ServiceConfig>,
  query: ParsedDoraRepoUrn,
): RepoUrnResolution {
  const claimants: string[] = [];
  for (const cfg of configs.values()) {
    // `some`, so a config naming the same repo twice is one claimant, not two.
    if (cfg.repos.some((u) => u.provider === query.provider && u.providerId === query.providerId)) {
      claimants.push(cfg.serviceId);
    }
  }
  return { serviceId: claimants[0] ?? null, candidateServiceIds: claimants };
}
