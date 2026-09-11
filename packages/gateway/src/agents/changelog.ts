import type { Database } from "bun:sqlite";
import type { GapNote } from "@nimbus-dev/sdk";

import {
  DEFAULT_DEPLOY_ENVIRONMENTS,
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  DEFAULT_EXCLUDE_PR_LABELS,
  DEFAULT_INCIDENT_WINDOW_MINUTES,
  type ServiceConfig,
} from "../metrics/dora-config.ts";
import type { ChangelogBrief } from "./_lib/changelog-types.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import {
  type ChangelogRow,
  type ChangelogScope,
  nonGithubMergedPrCount,
  selectDeployments,
  selectIncidentsOpened,
  selectIncidentsResolved,
  selectMergedPrs,
  type Window,
} from "./changelog-queries.ts";

/** Per-category display cap. Keeps a 500-PR window out of the synthesis prompt wholesale. */
export const CHANGELOG_CATEGORY_CAP = 50;

export type BuildChangelogArgs = {
  readonly db: Database;
  readonly nowMs: number;
  /**
   * A lookback DURATION, not an absolute cutoff — the repo-wide convention for an agent input
   * (`agents/decisions.ts:190` states it; `catchup.ts` computes `now - sinceMs`). Named
   * `lookbackMs` rather than `sinceMs` precisely so it cannot be handed to SQL by mistake:
   * `merged_at >= 604800000` is January 1970, and would return the whole index reported as
   * this week's changelog. `Window` below carries the converted absolute bounds.
   */
  readonly lookbackMs: number;
  readonly scope: ChangelogScope;
  /**
   * The configured service's `deployWorkflowPattern` when `--service` names one, else
   * `new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN)`. Passed in rather than read here so this
   * builder stays free of config loading and is trivially testable.
   */
  readonly deployPattern: RegExp;
  readonly latencyMs: number;
};

function cap(rows: readonly ChangelogRow[]): { kept: readonly ChangelogRow[]; dropped: number } {
  return rows.length <= CHANGELOG_CATEGORY_CAP
    ? { kept: rows, dropped: 0 }
    : {
        kept: rows.slice(0, CHANGELOG_CATEGORY_CAP),
        dropped: rows.length - CHANGELOG_CATEGORY_CAP,
      };
}

/**
 * The service name this brief was scoped to, derived from the scope rather than carried
 * alongside it: two fields saying the same thing is two fields free to disagree, and the one
 * the READER sees would be the one that never touched a query.
 */
function scopedServiceId(scope: ChangelogScope): string | null {
  return scope.kind === "all" ? null : scope.cfg.serviceId;
}

/**
 * A `--service` with nothing bound to it matches nothing in EVERY lane — `repos` decides PR and
 * CI membership, `pagerdutyServices` decides incidents — so its changelog is empty for a reason
 * the reader must be told. An empty changelog and a quiet week are otherwise indistinguishable.
 *
 * Keyed on the BINDINGS, not on whether `nimbus.toml` defines the service, so it stays true for
 * a service that is configured but bound to nothing. `missing_entity_type` matches
 * `ownership.ts`'s precedent for "that name does not reach any rows".
 */
function unboundServiceGap(scope: ChangelogScope): GapNote | undefined {
  if (scope.kind === "all") return undefined;
  const { cfg } = scope;
  if (cfg.repos.length > 0 || cfg.pagerdutyServices.length > 0) return undefined;
  return {
    category: "missing_entity_type",
    detail:
      `\`${cfg.serviceId}\` has no repositories and no PagerDuty services bound to it, so every ` +
      "entry below is empty because nothing can match it — not because nothing happened.",
    remediation:
      "Add `repos` and `pagerduty_services` to a `[ci.service.<id>]` block in `nimbus.toml`, or " +
      "run without `--service`.",
  };
}

export function buildChangelogBrief(args: BuildChangelogArgs): ChangelogBrief {
  // THE one conversion from duration to absolute bounds. Doing it anywhere else — or twice —
  // is the defect this naming exists to prevent.
  const w: Window = {
    fromMs: args.nowMs - args.lookbackMs,
    toMs: args.nowMs,
    scope: args.scope,
  };

  const merged = cap(selectMergedPrs(args.db, w));
  const deploys = cap(selectDeployments(args.db, w, args.deployPattern));
  const opened = cap(selectIncidentsOpened(args.db, w));
  const resolved = cap(selectIncidentsResolved(args.db, w));
  const nonGithub = nonGithubMergedPrCount(args.db, w);

  const all = [...merged.kept, ...deploys.kept, ...opened.kept, ...resolved.kept];
  const gaps: GapNote[] = [];

  // UNCONDITIONAL, following `ownership`'s standing-disclaimer precedent.
  gaps.push({
    category: "missing_entity_type",
    detail:
      "Dependency updates and configuration changes are not indexed as item types, so they " +
      "are absent from this changelog. Their absence here does not mean none occurred.",
    remediation:
      "No action available today — no connector indexes changed-file paths or dependency bumps " +
      "as their own item type.",
  });

  const unbound = unboundServiceGap(args.scope);
  if (unbound !== undefined) gaps.push(unbound);

  if (nonGithub > 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(nonGithub)} merged pull request(s) on a non-GitHub forge are not listed: ` +
        "`merged_at` is written by the GitHub connector alone, so GitLab and Bitbucket merges " +
        "carry no merge timestamp to window on.",
      remediation:
        "Track this as the same substrate gap `nimbus stats` reports as `github_only_merge_data`.",
    });
  }

  return {
    kind: "changelog",
    agentVersion: 1,
    generatedAt: args.nowMs,
    latencyMs: args.latencyMs,
    gaps,
    query: { sinceMs: w.fromMs, nowMs: args.nowMs, service: scopedServiceId(args.scope) },
    mergedPrs: merged.kept,
    deployments: deploys.kept,
    incidentsOpened: opened.kept,
    incidentsResolved: resolved.kept,
    counts: {
      mergedPrs: merged.kept.length,
      deployments: deploys.kept.length,
      incidentsOpened: opened.kept.length,
      incidentsResolved: resolved.kept.length,
    },
    indexTimedCount: all.filter((r) => r.timeSource === "index").length,
    nonGithubMergedPrs: nonGithub,
    truncatedCount: merged.dropped + deploys.dropped + opened.dropped + resolved.dropped,
  };
}

export async function emitChangelogBrief(opts: {
  readonly db: Database;
  readonly sessionId: string;
  /** A lookback DURATION — see `BuildChangelogArgs.lookbackMs`. */
  readonly lookbackMs: number;
  /** The `--service` the caller named, or `null` for every service. */
  readonly service: string | null;
  /** Loaded by the caller (`loadNimbusServiceConfigsFromConfigDir`), not read here. */
  readonly serviceConfigs: readonly ServiceConfig[];
  readonly notify: (method: string, params: unknown) => void;
  readonly runner?: SynthesisRunner;
}): Promise<{ sessionId: string }> {
  const started = Date.now();
  return await emitBriefWithSynthesis<ChangelogBrief>({
    sessionId: opts.sessionId,
    briefReadyMethod: "changelog.briefReady",
    briefErrorMethod: "changelog.briefError",
    notify: opts.notify,
    ...(opts.runner === undefined ? {} : { runner: opts.runner }),
    buildBrief: async () =>
      buildChangelogBrief({
        db: opts.db,
        nowMs: Date.now(),
        // A DURATION, converted to an absolute cutoff exactly once inside the builder.
        lookbackMs: opts.lookbackMs,
        scope: resolveScope(opts.service, opts.serviceConfigs),
        deployPattern: resolveDeployPattern(opts.service, opts.serviceConfigs),
        latencyMs: Date.now() - started,
      }),
  });
}

/**
 * A configured service's own pattern, else the project default.
 *
 * Naming an UNCONFIGURED service is not an error: the scope still narrows to that service (and
 * will legitimately find nothing), and the pattern falls back. Refusing would make the command
 * unusable on an index that has never had a `[ci.service.<id>]` block written for it.
 */
function resolveDeployPattern(service: string | null, configs: readonly ServiceConfig[]): RegExp {
  const cfg = service === null ? undefined : configs.find((c) => c.serviceId === service);
  return cfg?.deployWorkflowPattern ?? new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN);
}

function resolveScope(service: string | null, configs: readonly ServiceConfig[]): ChangelogScope {
  if (service === null) return { kind: "all" };
  const cfg = configs.find((c) => c.serviceId === service);
  // No config for this name means no repos and no PagerDuty ids to match on, so a scoped query
  // correctly matches nothing. `buildChangelogBrief` emits a gap saying so — silence here would
  // be indistinguishable from a quiet week.
  return { kind: "service", cfg: cfg ?? emptyServiceConfig(service) };
}

/**
 * A service the user named that `nimbus.toml` does not define.
 *
 * Empty `repos` and `pagerdutyServices` mean every scoped query matches nothing, which is the
 * honest answer — and `buildChangelogBrief`'s `unboundServiceGap` turns that silence into a
 * stated one, because an empty changelog and a quiet week are otherwise indistinguishable.
 */
function emptyServiceConfig(serviceId: string): ServiceConfig {
  return {
    serviceId,
    repos: [],
    pagerdutyServices: [],
    deployWorkflowPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    incidentWindowMinutes: DEFAULT_INCIDENT_WINDOW_MINUTES,
    excludePrLabels: [...DEFAULT_EXCLUDE_PR_LABELS],
    deployEnvironments: [...DEFAULT_DEPLOY_ENVIRONMENTS],
    severityP1Aliases: [],
  };
}
