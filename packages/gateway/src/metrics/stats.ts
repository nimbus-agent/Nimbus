import type { Database } from "bun:sqlite";
import {
  changeFailureRate,
  type DoraGap,
  type DoraMetricValue,
  deploymentFrequency,
  leadTimeForChanges,
  mttr,
} from "./dora.ts";
import type { ServiceConfig } from "./dora-config.ts";
import { splitBuckets } from "./stats-buckets.ts";

export type StatsMetricId =
  | "deployment-frequency"
  | "lead-time"
  | "change-failure-rate"
  | "mttr"
  | "pr-merges"
  | "incidents-opened";

/** DORA's own union stays frozen; this feature's extra reasons live here. */
export type StatsGap = DoraGap | "github_only_merge_data" | "incidents_missing_opened_at";

/**
 * `DoraMetricValue` with its `gap` field widened from `DoraGap` to `StatsGap`. A DORA
 * calculator's `DoraMetricValue` is still assignable here — `DoraGap` is a subset of
 * `StatsGap` — so `wrapDora` needs no conversion; only the two evaluators that return a
 * `StatsGap`-only reason (`github_only_merge_data`, `incidents_missing_opened_at`) need the
 * wider type, and get it without a cast.
 */
type StatsMetricValue = Omit<DoraMetricValue, "gap"> & { readonly gap: StatsGap };

export type StatsPoint = {
  readonly startMs: number;
  readonly endMs: number;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: StatsGap;
};

export type StatsSeries = {
  readonly metric: StatsMetricId;
  readonly service: string;
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly bucketMs: number;
  readonly points: readonly StatsPoint[];
};

type Evaluator = (
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
) => StatsMetricValue;

/**
 * A bucket is exactly "the DORA value for that sub-window". The four DORA calculators share
 * the signature `(db, cfg, nowMs, sinceMs)` where `sinceMs` is a LOOK-BACK DURATION, not an
 * absolute timestamp — every calculator computes its lower bound as `nowMs - sinceMs`
 * (confirmed by `dora.test.ts`'s `SINCE = 30 * ONE_DAY` and by `metrics-rpc.ts`'s
 * `parseSinceToMs`, which returns a duration). So reproducing "this bucket's sub-window"
 * means binding `nowMs` to the bucket's end and the duration `endMs - startMs` (== bucketMs)
 * to `sinceMs` — NOT the bucket's raw absolute `startMs`. Passing `startMs` itself would make
 * `nowMs - sinceMs` evaluate to a near-zero epoch value, turning every bucket's lower bound
 * into a no-op and silently making each point CUMULATIVE-to-date instead of per-bucket — no
 * DORA logic is reimplemented here either way; only the two numbers this wrapper computes
 * change.
 *
 * Known limit: the DORA calculators window inclusively (`>= lower AND <= nowMs`, dora.ts
 * `selectDeploys`/`selectAnnotatedDeploys`/`selectResolvedIncidents`), while `prMerges` and
 * `incidentsOpened` below window half-open (`>= start AND < end`). An event landing exactly
 * on a bucket boundary can therefore be double-counted across two adjacent buckets for the
 * four wrapped metrics, but not for the two native ones. Fixing that means touching `dora.ts`
 * itself, which this task deliberately does not do — recorded here rather than left to
 * surprise someone diffing bucket edges.
 */
const wrapDora =
  (
    fn: (db: Database, cfg: ServiceConfig, nowMs: number, sinceMs: number) => DoraMetricValue,
  ): Evaluator =>
  (db, cfg, startMs, endMs) =>
    fn(db, cfg, endMs, endMs - startMs);

/**
 * `merged_at` is written ONLY by `connectors/github-sync.ts`; gitlab-sync and bitbucket-sync
 * write nothing. `json_valid(metadata)` guards `json_extract`, which RAISES on malformed
 * JSON in this codebase — and the guard is context-dependent, so it must sit in the WHERE
 * clause beside the extract, not merely somewhere in the statement.
 */
function prMerges(
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
): StatsMetricValue {
  // `ParsedDoraRepoUrn` is `{ provider: DoraProvider; providerId: string }` — there is NO
  // `forge` field. `DoraProvider` is "github" | "gitlab" | "bitbucket" | "jenkins" | "circleci".
  const githubRepos = cfg.repos.filter((r) => r.provider === "github").map((r) => r.providerId);
  if (githubRepos.length === 0) {
    // Either the service binds no repos at all, or none of them are GitHub — and only
    // github-sync.ts writes `merged_at`, so there is nothing this metric can count.
    return { value: null, unit: "merges", sample: 0, gap: "no_repos" };
  }
  const nonGithub = cfg.repos.some((r) => r.provider !== "github");
  const ph = githubRepos.map(() => "?").join(",");
  // Spec § 5: scoped to the SERVICE's bound repos. `metadata.repo` is the key
  // `repoLikeMatchesUrn` (dora.ts:65) matches GitHub URNs on — that helper is module-private
  // in dora.ts, so this mirrors its predicate rather than importing it.
  // `json_valid` guards `json_extract`, which RAISES on malformed JSON here, and the guard is
  // context-dependent — it must sit in the WHERE clause beside every extract.
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM item
       WHERE type = 'pr'
         AND json_valid(metadata)
         AND json_extract(metadata, '$.repo') IN (${ph})
         AND json_extract(metadata, '$.merged_at') IS NOT NULL
         AND json_extract(metadata, '$.merged_at') >= ?
         AND json_extract(metadata, '$.merged_at') < ?`,
    )
    .get(...githubRepos, startMs, endMs) as { c: number } | null;
  const count = row?.c ?? 0;
  if (count === 0) {
    return {
      value: null,
      unit: "merges",
      sample: 0,
      gap: nonGithub ? "github_only_merge_data" : "low_sample",
    };
  }
  return {
    value: count,
    unit: "merges",
    sample: count,
    gap: nonGithub ? "github_only_merge_data" : null,
  };
}

/**
 * `incidents-opened` is deliberately NOT `selectResolvedIncidents` (dora.ts:286) reused
 * wholesale — three corrections apply:
 *  (a) that function windows on `i.modified_at` (last-touch); this metric must window on
 *      when the incident OPENED, so only the service-scoping predicate is reused, not the
 *      time predicate.
 *  (b) that function filters to `status === "resolved"` for MTTR's duration arithmetic; an
 *      incident opened in this window but still burning is still counted here.
 *  (c) that function falls back to `r.synced_at` (our indexing time) when `opened_at_ms` is
 *      missing. That fallback is forbidden by this feature's governing rule — `synced_at` is
 *      not a real event timestamp. Rows without a real `opened_at_ms` are excluded from every
 *      bucket and the exclusion is reported via `incidents_missing_opened_at`, never silently
 *      back-dated.
 */
function incidentsOpened(
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
): StatsMetricValue {
  if (cfg.pagerdutyServices.length === 0) {
    return { value: null, unit: "incidents", sample: 0, gap: "no_pagerduty_mapping" };
  }
  const ph = cfg.pagerdutyServices.map(() => "?").join(",");
  // `json_valid` guards `json_extract`, which RAISES on malformed JSON here — and the guard
  // is context-dependent, so it must sit in the WHERE clause beside every extract.
  const scope = `FROM item
     WHERE service = 'pagerduty' AND type = 'incident'
       AND json_valid(metadata)
       AND json_extract(metadata, '$.pagerduty_service_id') IN (${ph})`;
  const counted = db
    .query(
      `SELECT COUNT(*) AS c ${scope}
         AND json_extract(metadata, '$.opened_at_ms') >= ?
         AND json_extract(metadata, '$.opened_at_ms') < ?`,
    )
    .get(...cfg.pagerdutyServices, startMs, endMs) as { c: number } | null;
  // Incidents this service owns that carry NO opened timestamp at all. They cannot be placed
  // in any bucket, so they are excluded from every one — and that exclusion is reported
  // rather than hidden. Deliberately not windowed: an untimestamped row cannot be windowed.
  const untimed = db
    .query(`SELECT COUNT(*) AS c ${scope} AND json_extract(metadata, '$.opened_at_ms') IS NULL`)
    .get(...cfg.pagerdutyServices) as { c: number } | null;
  const count = counted?.c ?? 0;
  const missing = (untimed?.c ?? 0) > 0;
  if (count === 0) {
    return {
      value: null,
      unit: "incidents",
      sample: 0,
      gap: missing ? "incidents_missing_opened_at" : "low_sample",
    };
  }
  return {
    value: count,
    unit: "incidents",
    sample: count,
    gap: missing ? "incidents_missing_opened_at" : null,
  };
}

const STATS_METRICS: Readonly<Record<StatsMetricId, Evaluator>> = {
  "deployment-frequency": wrapDora(deploymentFrequency),
  "lead-time": wrapDora(leadTimeForChanges),
  "change-failure-rate": wrapDora(changeFailureRate),
  mttr: wrapDora(mttr),
  "pr-merges": prMerges,
  "incidents-opened": incidentsOpened,
};

/** Derived from the registry so the two cannot disagree. */
export const STATS_METRIC_IDS = Object.keys(STATS_METRICS) as readonly StatsMetricId[];

export function computeStatsSeries(
  db: Database,
  cfg: ServiceConfig,
  metric: StatsMetricId,
  untilMs: number,
  windowMs: number,
  bucketMs: number,
): StatsSeries {
  const evaluate = STATS_METRICS[metric];
  const buckets = splitBuckets(untilMs, windowMs, bucketMs);
  const points = buckets.map((b) => {
    const v = evaluate(db, cfg, b.startMs, b.endMs);
    return { startMs: b.startMs, endMs: b.endMs, ...v };
  });
  return {
    metric,
    service: cfg.serviceId,
    window: { sinceMs: untilMs - windowMs, untilMs },
    bucketMs,
    points,
  };
}
