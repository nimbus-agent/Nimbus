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
  /**
   * A `performance.now()` ORIGIN, not an elapsed duration — `latencyMs` is computed at the END
   * of `buildChangelogBrief`, after the five queries have run, exactly as `ownership.ts:331`,
   * `decisions.ts:279` and `glossary.ts:205` do.
   *
   * Taking the elapsed time as an INPUT is the defect this shape exists to prevent: an
   * `latencyMs: Date.now() - started` written in the caller's object literal is evaluated
   * BEFORE the function body runs, so it times argument resolution and reports ~0 ms in a
   * footer the reader sees.
   */
  readonly startedAtMs: number;
};

/**
 * Split a category's rows into the ones that will be LISTED and the ones the display cap drops,
 * keeping the true total so `counts` can report what the window actually held.
 *
 * `total` is not `kept.length` — that difference is the whole point. See `ChangelogCounts`.
 */
function cap(rows: readonly ChangelogRow[]): {
  kept: readonly ChangelogRow[];
  dropped: number;
  total: number;
} {
  return rows.length <= CHANGELOG_CATEGORY_CAP
    ? { kept: rows, dropped: 0, total: rows.length }
    : {
        kept: rows.slice(0, CHANGELOG_CATEGORY_CAP),
        dropped: rows.length - CHANGELOG_CATEGORY_CAP,
        total: rows.length,
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
 * A `--service` with nothing bound to it reaches no rows in THREE of the four lanes — `repos`
 * decides merged-PR and CI-run-deployment membership, `pagerdutyServices` decides both incident
 * lanes — so those sections are empty for a reason the reader must be told. An empty changelog
 * and a quiet week are otherwise indistinguishable.
 *
 * **Three, not four.** The fourth lane is ANNOTATED deployments, which
 * `selectAnnotatedDeployments` scopes on `deployment_items.nimbus_service_id = cfg.serviceId` —
 * the service id ITSELF, needing no `repos` and no `pagerduty_services` entry. An earlier draft
 * said "every entry below is empty because nothing can match it", which a brief listing an
 * annotated deploy contradicts on its own face: the section above the gap note holds an entry
 * the note says cannot exist. Narrowed by WORDING rather than by pre-checking the deploy rows,
 * so the note stays a statement about the BINDINGS (which is what the remediation acts on) and
 * cannot disagree with a lane it does not query.
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
      `\`${cfg.serviceId}\` has no repositories and no PagerDuty services bound to it, so no ` +
      "merged pull request, CI-run deployment or incident can match it — those sections are " +
      "empty because nothing can match, not because nothing happened. Deployments annotated " +
      "through `POST /v1/deployments` are unaffected: they match on the service id itself, so " +
      "any entry under Deployments came from that route.",
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

  const mergedRows = selectMergedPrs(args.db, w);
  const deployRows = selectDeployments(args.db, w, args.deployPattern);
  const openedRows = selectIncidentsOpened(args.db, w);
  const resolvedRows = selectIncidentsResolved(args.db, w);
  const nonGithub = nonGithubMergedPrCount(args.db, w);

  const merged = cap(mergedRows);
  const deploys = cap(deployRows);
  const opened = cap(openedRows);
  const resolved = cap(resolvedRows);

  // EVERY matched row, not just the listed ones — `indexTimedCount` is a claim about what the
  // WINDOW held, on the same basis as `counts`. Counting only the kept rows would make the
  // time-basis disclosure quietly mean "of the entries shown", the same ambiguity `counts`
  // carried before the pre-cap fix, and the two numbers would then be on different bases in
  // one brief.
  const allRows = [...mergedRows, ...deployRows, ...openedRows, ...resolvedRows];
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
        "carry no merge timestamp to window on. That count is itself an estimate for the same " +
        "reason — with no merge timestamp it windows on when the index last touched the row, so " +
        "it omits a merge whose row has not been re-synced and includes an older merge that was " +
        "touched during the window.",
      remediation:
        "Track this as the same substrate gap `nimbus stats` reports as `github_only_merge_data`.",
    });
  }

  return {
    kind: "changelog",
    agentVersion: 1,
    generatedAt: args.nowMs,
    // Computed HERE, after the five queries above, never taken as an input — see
    // `BuildChangelogArgs.startedAtMs`.
    latencyMs: Math.round(performance.now() - args.startedAtMs),
    gaps,
    query: { sinceMs: w.fromMs, nowMs: args.nowMs, service: scopedServiceId(args.scope) },
    mergedPrs: merged.kept,
    deployments: deploys.kept,
    incidentsOpened: opened.kept,
    incidentsResolved: resolved.kept,
    // TRUE, pre-cap totals — deliberately NOT `kept.length`. See `ChangelogCounts`.
    counts: {
      mergedPrs: merged.total,
      deployments: deploys.total,
      incidentsOpened: opened.total,
      incidentsResolved: resolved.total,
    },
    indexTimedCount: allRows.filter((r) => r.timeSource === "index").length,
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
  // The ORIGIN the builder measures against, taken before any work begins. `performance.now()`
  // rather than `Date.now()`, matching `ownership.ts` / `decisions.ts` / `glossary.ts`: a
  // monotonic clock cannot be walked backwards by an NTP step mid-brief.
  const startedAtMs = performance.now();
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
        startedAtMs,
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
