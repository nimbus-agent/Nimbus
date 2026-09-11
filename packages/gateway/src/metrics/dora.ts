import type { Database } from "bun:sqlite";
import type { ParsedDoraRepoUrn, ServiceConfig } from "./dora-config.ts";
import { distinctCiServiceColumns, distinctPrServiceColumns } from "./dora-config.ts";

export type DoraGap =
  | null
  // The service id is in neither `[metrics.dora.<id>]` nor `[ci.service.<id>]`. Distinct from
  // `no_repos`, which means the service EXISTS with no repos bound — a different and much more
  // fixable-looking problem, and the one `unconfiguredEnvelope` used to report for BOTH. See F24b.
  | "unknown_service"
  | "no_pagerduty_mapping"
  | "no_repos"
  | "no_deployment_data"
  | "low_sample"
  | "approximate_lead_time"
  | "mixed_source";

export type DoraMetricValue = {
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: DoraGap;
};

export type DoraMetricsResult = {
  readonly service: string;
  readonly since_ms: number;
  readonly computed_at: string;
  readonly metrics: {
    readonly deployment_frequency: DoraMetricValue;
    readonly lead_time_for_changes: DoraMetricValue;
    readonly change_failure_rate: DoraMetricValue;
    readonly mttr: DoraMetricValue;
  };
};

const LOW_SAMPLE_THRESHOLD = 3;

function gapOrNull(metric: DoraMetricValue): DoraMetricValue {
  if (metric.value !== null && metric.sample < LOW_SAMPLE_THRESHOLD && metric.gap === null) {
    return { ...metric, gap: "low_sample" };
  }
  return metric;
}

function medianOfSorted(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) throw new Error("medianOfSorted: empty array");
  if (n % 2 === 1) {
    const v = sorted[(n - 1) / 2];
    if (v === undefined) throw new Error("medianOfSorted: undefined entry");
    return v;
  }
  const a = sorted[n / 2 - 1];
  const b = sorted[n / 2];
  if (a === undefined || b === undefined) throw new Error("medianOfSorted: undefined entry");
  return Math.floor((a + b) / 2);
}

function repoLikeMatchesUrn(
  metadata: Record<string, unknown> | null,
  externalId: string,
  urn: ParsedDoraRepoUrn,
): boolean {
  if (metadata === null) return false;
  switch (urn.provider) {
    case "github":
    case "bitbucket":
      return metadata["repo"] === urn.providerId;
    case "gitlab":
      return metadata["project"] === urn.providerId || metadata["repo"] === urn.providerId;
    case "jenkins":
      return metadata["jobName"] === urn.providerId;
    case "circleci":
      return externalId.includes(urn.providerId);
  }
}

type CiRunRow = {
  id: string;
  external_id: string;
  title: string;
  modified_at: number;
  metadata: string | null;
};

function selectDeploys(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): CiRunRow[] {
  const ciServices = distinctCiServiceColumns(cfg.repos);
  if (ciServices.length === 0) return [];
  const placeholders = ciServices.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT id, external_id, title, modified_at, metadata
       FROM item
       WHERE service IN (${placeholders})
         AND type = 'ci_run'
         AND modified_at >= ?
         AND modified_at <= ?`,
    )
    .all(...ciServices, nowMs - sinceMs, nowMs) as CiRunRow[];
  const out: CiRunRow[] = [];
  for (const row of rows) {
    if (!cfg.deployWorkflowPattern.test(row.title)) continue;
    const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null;
    if (meta?.["conclusion"] !== "success") continue;
    if (!cfg.repos.some((u) => repoLikeMatchesUrn(meta, row.external_id, u))) continue;
    out.push(row);
  }
  return out;
}

type AnnotatedDeployRow = {
  id: string;
  modified_at: number;
  metadata: string | null;
};

function selectAnnotatedDeploys(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): AnnotatedDeployRow[] {
  if (cfg.deployEnvironments.length === 0) return [];
  const placeholders = cfg.deployEnvironments.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT i.id AS id, i.modified_at AS modified_at, i.metadata AS metadata
       FROM item i
       JOIN deployment_items d ON d.id = i.id
       WHERE i.type = 'deployment'
         AND d.nimbus_service_id = ?
         AND d.environment IN (${placeholders})
         AND d.conclusion = 'success'
         AND i.modified_at >= ?
         AND i.modified_at <= ?
       ORDER BY i.modified_at ASC`,
    )
    .all(cfg.serviceId, ...cfg.deployEnvironments, nowMs - sinceMs, nowMs) as AnnotatedDeployRow[];
  return rows;
}

export function deploymentFrequency(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): DoraMetricValue {
  if (cfg.repos.length === 0) {
    return { value: null, unit: "deploys_per_day", sample: 0, gap: "no_repos" };
  }
  const annotated = selectAnnotatedDeploys(db, cfg, nowMs, sinceMs);
  const regex = selectDeploys(db, cfg, nowMs, sinceMs);
  if (annotated.length > 0) {
    const mixedSource = regex.length > 0;
    const days = sinceMs / 86_400_000;
    const value = annotated.length / days;
    return gapOrNull({
      value,
      unit: "deploys_per_day",
      sample: annotated.length,
      gap: mixedSource ? "mixed_source" : null,
    });
  }
  if (regex.length === 0) {
    return { value: null, unit: "deploys_per_day", sample: 0, gap: "no_deployment_data" };
  }
  const days = sinceMs / 86_400_000;
  const value = regex.length / days;
  return gapOrNull({ value, unit: "deploys_per_day", sample: regex.length, gap: null });
}

type PrRow = {
  id: string;
  modified_at: number;
  metadata: string | null;
};

type DeployIdx = {
  headSha: string | null;
  modifiedAt: number;
};

function buildDeployIndex(deploys: readonly CiRunRow[]): DeployIdx[] {
  return deploys.map((d) => {
    const meta = d.metadata ? (JSON.parse(d.metadata) as Record<string, unknown>) : null;
    const rawHead = meta === null ? undefined : meta["headSha"];
    const headSha = typeof rawHead === "string" ? rawHead : null;
    return { headSha, modifiedAt: d.modified_at };
  });
}

type PrLeadTime = { leadTime: number | null; approximate: boolean };

function prLeadTime(
  pr: PrRow,
  deployIdx: readonly DeployIdx[],
  excludePrLabels: readonly string[],
): PrLeadTime {
  const meta = pr.metadata ? (JSON.parse(pr.metadata) as Record<string, unknown>) : null;
  if (meta?.["merged"] !== true) return { leadTime: null, approximate: false };
  const mergedAtRaw = meta["merged_at"];
  const mergedAt = typeof mergedAtRaw === "number" ? mergedAtRaw : null;
  if (mergedAt === null) return { leadTime: null, approximate: false };
  const labelsRaw = meta["labels"];
  const labels: readonly unknown[] = Array.isArray(labelsRaw) ? labelsRaw : [];
  if (labels.some((l) => typeof l === "string" && excludePrLabels.includes(l))) {
    return { leadTime: null, approximate: false };
  }
  const mergeShaRaw = meta["merge_commit_sha"];
  const mergeSha = typeof mergeShaRaw === "string" ? mergeShaRaw : null;
  if (mergeSha === null) return { leadTime: null, approximate: true };
  const match = deployIdx.find((d) => d.headSha === mergeSha && d.modifiedAt >= mergedAt);
  if (match === undefined) return { leadTime: null, approximate: true };
  return { leadTime: Math.floor((match.modifiedAt - mergedAt) / 1000), approximate: false };
}

export function leadTimeForChanges(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): DoraMetricValue {
  if (cfg.repos.length === 0) {
    return { value: null, unit: "seconds_median", sample: 0, gap: "no_repos" };
  }
  const deploys = selectDeploys(db, cfg, nowMs, sinceMs);
  if (deploys.length === 0) {
    return { value: null, unit: "seconds_median", sample: 0, gap: "no_deployment_data" };
  }
  const prServices = distinctPrServiceColumns(cfg.repos);
  if (prServices.length === 0) {
    return { value: null, unit: "seconds_median", sample: 0, gap: "approximate_lead_time" };
  }
  const placeholders = prServices.map(() => "?").join(",");
  const prRows = db
    .query(
      `SELECT id, modified_at, metadata FROM item
       WHERE service IN (${placeholders})
         AND type = 'pr'
         AND modified_at >= ?
         AND modified_at <= ?`,
    )
    .all(...prServices, nowMs - sinceMs, nowMs) as PrRow[];

  const deployIdx = buildDeployIndex(deploys);
  const leadTimes: number[] = [];
  let anyApproximate = false;
  for (const pr of prRows) {
    const { leadTime, approximate } = prLeadTime(pr, deployIdx, cfg.excludePrLabels);
    if (approximate) anyApproximate = true;
    if (leadTime !== null) leadTimes.push(leadTime);
  }
  if (leadTimes.length === 0) {
    return {
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: anyApproximate ? "approximate_lead_time" : "no_deployment_data",
    };
  }
  leadTimes.sort((a, b) => a - b);
  const median = medianOfSorted(leadTimes);
  return gapOrNull({
    value: median,
    unit: "seconds_median",
    sample: leadTimes.length,
    gap: anyApproximate ? "approximate_lead_time" : null,
  });
}

type IncidentRow = {
  id: string;
  modified_at: number;
  metadata: string | null;
  synced_at: number;
};

type ResolvedIncident = {
  opened: number;
  resolved: number;
  pdService: string;
};

function selectResolvedIncidents(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): ResolvedIncident[] {
  if (cfg.pagerdutyServices.length === 0) return [];
  const placeholders = cfg.pagerdutyServices.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT i.id, i.modified_at, i.metadata, i.synced_at
       FROM item i
       WHERE i.service = 'pagerduty'
         AND i.type = 'incident'
         AND json_extract(i.metadata, '$.pagerduty_service_id') IN (${placeholders})
         AND i.modified_at >= ?
         AND i.modified_at <= ?`,
    )
    .all(...cfg.pagerdutyServices, nowMs - sinceMs, nowMs) as IncidentRow[];
  const out: ResolvedIncident[] = [];
  for (const r of rows) {
    const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null;
    if (meta?.["status"] !== "resolved") continue;
    const openedRaw = meta["opened_at_ms"];
    const opened = typeof openedRaw === "number" ? openedRaw : r.synced_at;
    const pdRaw = meta["pagerduty_service_id"];
    const pdService = typeof pdRaw === "string" ? pdRaw : "";
    out.push({ opened, resolved: r.modified_at, pdService });
  }
  return out;
}

type AttributionIncident = {
  opened: number;
};

/**
 * Incidents that could be ATTRIBUTED to a deploy inside `[startMs, endMs]`.
 *
 * Deliberately NOT `selectResolvedIncidents`, which is correct for `mttr` and wrong here, for
 * one reason: **the column it windows on is not the column attribution reads.** It bounds on
 * `i.modified_at` — for a resolved incident, effectively RESOLUTION time — while the
 * attribution loop compares `opened_at_ms`. An incident opened inside the window moments after
 * a deploy, but resolved after the window's upper edge, was therefore never a candidate and its
 * deploy was reported CLEAN. That is not a corner case: `mttr` exists precisely because
 * resolution lag runs to hours and days, so it is the normal shape near any upper edge.
 *
 * It matters far more for a SERIES than for the single scalar this originally served. A
 * `GET /v1/metrics/dora` window has exactly one upper edge, `now`, where the incident genuinely
 * has not happened yet and no contract can do better. A series has N upper edges and every one
 * of them is in the past, with the incident sitting in the index, readable, and ignored.
 *
 * Two bounds, both deliberate:
 *  - The upper bound extends past `endMs` by `incidentWindowMs` and no further, because a deploy
 *    just inside the edge can still be blamed for an incident opening just outside it. The
 *    DEPLOY selection is NOT widened to match — `deploys.length` is the denominator, so widening
 *    it would change the number the metric reports rather than correct it.
 *  - There is no `synced_at` fallback. `selectResolvedIncidents` has one, and it is indefensible
 *    for attribution specifically: `synced_at` is our INDEXING time, so falling back to it blames
 *    whichever deploy happened to precede the moment we happened to index the row. An incident
 *    with no real opened timestamp is excluded from attribution instead, matching the rule
 *    `stats.ts`'s `incidentsOpened` already states for the same reason.
 *
 * `json_valid` guards every `json_extract`, which RAISES on malformed JSON in this position.
 *
 * There is deliberately NO `status = 'resolved'` predicate, which is the second half of the same
 * defect and was closed a step later. `selectResolvedIncidents` requires it because MTTR needs a
 * resolution timestamp to compute a duration; attribution reads only `opened`, so inheriting that
 * filter answered a question this function is not asking. While it stood, a deploy that caused an
 * outage was reported CLEAN for as long as the outage was still burning, and became a change
 * failure only once somebody closed the ticket. Worse, it made the metric depend on something
 * nobody chose: a resolved incident whose row has not been re-synced still reads `triggered` here,
 * so the answer moved with how fresh the PagerDuty sync happened to be. `stats.ts`'s
 * `incidentsOpened` — which asks the same shape of question, what opened in this window — has no
 * status predicate either, and is the precedent.
 */
function selectAttributionIncidents(
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
  incidentWindowMs: number,
): AttributionIncident[] {
  if (cfg.pagerdutyServices.length === 0) return [];
  const placeholders = cfg.pagerdutyServices.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT json_extract(i.metadata, '$.opened_at_ms') AS opened
       FROM item i
       WHERE i.service = 'pagerduty'
         AND i.type = 'incident'
         AND json_valid(i.metadata)
         AND json_extract(i.metadata, '$.pagerduty_service_id') IN (${placeholders})
         AND json_extract(i.metadata, '$.opened_at_ms') >= ?
         AND json_extract(i.metadata, '$.opened_at_ms') <= ?`,
    )
    .all(...cfg.pagerdutyServices, startMs, endMs + incidentWindowMs) as { opened: unknown }[];
  const out: AttributionIncident[] = [];
  for (const r of rows) {
    // Re-checked in TypeScript rather than trusted from SQL: `opened_at_ms` is connector-written
    // metadata, and a string there would compare by SQLite's type ordering rather than numerically.
    if (typeof r.opened === "number") out.push({ opened: r.opened });
  }
  return out;
}

export function changeFailureRate(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): DoraMetricValue {
  if (cfg.repos.length === 0) {
    return { value: null, unit: "ratio", sample: 0, gap: "no_repos" };
  }
  const deploys = selectDeploys(db, cfg, nowMs, sinceMs);
  if (deploys.length === 0) {
    return { value: null, unit: "ratio", sample: 0, gap: "no_deployment_data" };
  }
  if (cfg.pagerdutyServices.length === 0) {
    return { value: null, unit: "ratio", sample: deploys.length, gap: "no_pagerduty_mapping" };
  }
  const windowMs = cfg.incidentWindowMinutes * 60_000;
  const incidents = selectAttributionIncidents(db, cfg, nowMs - sinceMs, nowMs, windowMs);
  const sortedDeploys = deploys
    .map((d) => ({ id: d.id, t: d.modified_at }))
    .sort((a, b) => a.t - b.t);
  const failedDeployIds = new Set<string>();
  for (const inc of incidents) {
    let attributed: string | undefined;
    for (const d of sortedDeploys) {
      if (d.t <= inc.opened && inc.opened - d.t <= windowMs) attributed = d.id;
      if (d.t > inc.opened) break;
    }
    if (attributed !== undefined) failedDeployIds.add(attributed);
  }
  const value = failedDeployIds.size / deploys.length;
  return gapOrNull({ value, unit: "ratio", sample: deploys.length, gap: null });
}

export function mttr(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): DoraMetricValue {
  if (cfg.pagerdutyServices.length === 0) {
    return { value: null, unit: "seconds_median", sample: 0, gap: "no_pagerduty_mapping" };
  }
  const incidents = selectResolvedIncidents(db, cfg, nowMs, sinceMs);
  if (incidents.length === 0) {
    return { value: null, unit: "seconds_median", sample: 0, gap: "low_sample" };
  }
  const durations = incidents.map((i) => Math.max(0, Math.floor((i.resolved - i.opened) / 1000)));
  durations.sort((a, b) => a - b);
  const median = medianOfSorted(durations);
  const lowSampleGap: DoraGap = durations.length < LOW_SAMPLE_THRESHOLD ? "low_sample" : null;
  return { value: median, unit: "seconds_median", sample: durations.length, gap: lowSampleGap };
}

export function computeDoraMetrics(
  db: Database,
  cfg: ServiceConfig,
  nowMs: number,
  sinceMs: number,
): DoraMetricsResult {
  return {
    service: cfg.serviceId,
    since_ms: sinceMs,
    computed_at: new Date(nowMs).toISOString(),
    metrics: {
      deployment_frequency: deploymentFrequency(db, cfg, nowMs, sinceMs),
      lead_time_for_changes: leadTimeForChanges(db, cfg, nowMs, sinceMs),
      change_failure_rate: changeFailureRate(db, cfg, nowMs, sinceMs),
      mttr: mttr(db, cfg, nowMs, sinceMs),
    },
  };
}
