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
export type StatsGap =
  | DoraGap
  // Retained for API compatibility (public OpenAPI enum); no longer emitted — superseded by
  // "incomplete_merge_data".
  | "github_only_merge_data"
  | "incomplete_merge_data"
  | "incidents_missing_opened_at";

/**
 * `DoraMetricValue` with its `gap` field widened from `DoraGap` to `StatsGap`. A DORA
 * calculator's `DoraMetricValue` is still assignable here — `DoraGap` is a subset of
 * `StatsGap` — so `wrapDora` needs no conversion; only the two evaluators that return a
 * `StatsGap`-only reason (`incomplete_merge_data`, `incidents_missing_opened_at`) need the
 * wider type, and get it without a cast.
 */
type StatsMetricValue = Omit<DoraMetricValue, "gap"> & { readonly gap: StatsGap };

/**
 * WIRE SHAPE — snake_case, deliberately. This type is serialised verbatim as the
 * `metrics.stats` JSON-RPC response, and the sibling method on the same namespace
 * (`metrics.dora` → `DoraMetricsResult`) already ships `since_ms` / `computed_at`, while the
 * request params are `window_ms` / `bucket_ms`. One method mixing both conventions on the
 * wire is the defect this naming avoids; the internal `StatsBucket`
 * (`stats-buckets.ts`) stays camelCase because it never leaves the process.
 */
export type StatsPoint = {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: StatsGap;
};

/** Wire shape — see `StatsPoint` on why these fields are snake_case. */
export type StatsSeries = {
  readonly metric: StatsMetricId;
  readonly service: string;
  readonly window: { readonly since_ms: number; readonly until_ms: number };
  readonly bucket_ms: number;
  readonly points: readonly StatsPoint[];
};

type Evaluator = (
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
) => StatsMetricValue;

/**
 * A reason that is true of the WHOLE SERIES rather than of any one bucket — computed ONCE
 * per `computeStatsSeries` call, never per bucket. Returns `null` when there is nothing to
 * disclose. See `computeStatsSeries` for how a disclosure is placed.
 */
type SeriesDisclosure = (db: Database, cfg: ServiceConfig) => StatsGap;

type MetricEntry = {
  readonly evaluate: Evaluator;
  readonly disclose?: SeriesDisclosure;
};

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
 *
 * Second known limit, inherited for the same reason: the four wrapped calculators window on
 * `item.modified_at` (last touch), not on an event timestamp of their own. For `ci_run` and
 * `deployment` rows that IS effectively event time — `deployment/annotate.ts` binds
 * `started_at_ms` into `modified_at`, and `connectors/github-actions-sync.ts` binds the run's
 * `created_at` — but for the `pr` rows `lead-time` reads and the `incident` rows
 * `change-failure-rate` and `mttr` read, `modified_at` is genuine last-touch
 * (`connectors/github-sync.ts` binds a PR's `updated_at`; `connectors/pagerduty-sync.ts`
 * binds an incident's). `mttr` additionally falls back to
 * `synced_at` for an incident with no `opened_at_ms` (dora.ts `selectResolvedIncidents`).
 * Both are the accepted cost of calling the tested calculators unchanged instead of
 * reimplementing them; only `pr-merges` and `incidents-opened` below bucket on a true event
 * timestamp. Documented in `docs/CHANGELOG.md`'s 2026-08-19 entry and the design spec § 3 D1.
 */
const wrapDora =
  (
    fn: (db: Database, cfg: ServiceConfig, nowMs: number, sinceMs: number) => DoraMetricValue,
  ): Evaluator =>
  (db, cfg, startMs, endMs) =>
    fn(db, cfg, endMs, endMs - startMs);

/**
 * Merge counts come from the two forges that record a merge time on the PR row: GitHub always,
 * GitLab from its `accepted`/`merged` events (only for merges inside the synced window).
 * Bitbucket never records one. `service` is matched per forge so an `owner/name` shared across
 * forges is never counted twice. `json_valid(metadata)` guards `json_extract`, which RAISES on
 * malformed JSON in this codebase — and the guard is context-dependent, so it must sit in the
 * WHERE clause beside the extract, not merely somewhere in the statement.
 */
function prMerges(
  db: Database,
  cfg: ServiceConfig,
  startMs: number,
  endMs: number,
): StatsMetricValue {
  const githubRepos = cfg.repos.filter((r) => r.provider === "github").map((r) => r.providerId);
  const gitlabRepos = cfg.repos.filter((r) => r.provider === "gitlab").map((r) => r.providerId);
  const incomplete = cfg.repos.some((r) => r.provider === "gitlab" || r.provider === "bitbucket");
  if (githubRepos.length === 0 && gitlabRepos.length === 0) {
    return {
      value: null,
      unit: "merges",
      sample: 0,
      gap: incomplete ? "incomplete_merge_data" : "no_repos",
    };
  }
  // Scoped to the SERVICE's bound repos on `metadata.repo` (mirrors dora.ts's predicate).
  const forgeClauses: string[] = [];
  const params: Array<string | number> = [];
  if (githubRepos.length > 0) {
    forgeClauses.push(
      `(service = 'github' AND json_extract(metadata, '$.repo') IN (${githubRepos.map(() => "?").join(",")}))`,
    );
    params.push(...githubRepos);
  }
  if (gitlabRepos.length > 0) {
    forgeClauses.push(
      `(service = 'gitlab' AND json_extract(metadata, '$.repo') IN (${gitlabRepos.map(() => "?").join(",")}))`,
    );
    params.push(...gitlabRepos);
  }
  // lane-census: scope=pr service=github,gitlab
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM item
       WHERE type = 'pr'
         AND json_valid(metadata)
         AND (${forgeClauses.join(" OR ")})
         AND json_extract(metadata, '$.merged_at') IS NOT NULL
         AND json_extract(metadata, '$.merged_at') >= ?
         AND json_extract(metadata, '$.merged_at') < ?`,
    )
    .get(...params, startMs, endMs) as { c: number } | null;
  const count = row?.c ?? 0;
  const gap: StatsGap | null = incomplete ? "incomplete_merge_data" : null;
  if (count === 0) {
    return { value: null, unit: "merges", sample: 0, gap: gap ?? "low_sample" };
  }
  return { value: count, unit: "merges", sample: count, gap };
}

/** The service-scoping half of the incident predicate, shared by the count and the probe. */
function incidentScopeSql(placeholders: string): string {
  // `json_valid` guards `json_extract`, which RAISES on malformed JSON here — and the guard
  // is context-dependent, so it must sit in the WHERE clause beside every extract.
  return `FROM item
     WHERE service = 'pagerduty' AND type = 'incident'
       AND json_valid(metadata)
       AND json_extract(metadata, '$.pagerduty_service_id') IN (${placeholders})`;
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
 *      back-dated — see `discloseUntimedIncidents`, which is a SERIES-level probe, not a
 *      per-bucket one.
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
  const counted = db
    .query(
      `SELECT COUNT(*) AS c ${incidentScopeSql(ph)}
         AND json_extract(metadata, '$.opened_at_ms') >= ?
         AND json_extract(metadata, '$.opened_at_ms') < ?`,
    )
    .get(...cfg.pagerdutyServices, startMs, endMs) as { c: number } | null;
  const count = counted?.c ?? 0;
  if (count === 0) {
    // `low_sample` is this BUCKET's own reason. The untimed-incident exclusion belongs to the
    // whole series and is attached by `computeStatsSeries`, which will not displace a reason
    // a bucket derived for itself.
    return { value: null, unit: "incidents", sample: 0, gap: "low_sample" };
  }
  return { value: count, unit: "incidents", sample: count, gap: null };
}

/**
 * Incidents this service owns that carry NO opened timestamp at all. They cannot be placed
 * in any bucket, so they are excluded from every one — and that exclusion is reported rather
 * than hidden.
 *
 * Deliberately unwindowed AND deliberately series-level: an untimestamped row cannot be
 * windowed (windowing it on `modified_at` would reintroduce exactly the last-touch timestamp
 * this feature refuses to bucket on), so the same answer came back for every bucket — one
 * identical query per bucket, and one ancient untimed incident stamped
 * `incidents_missing_opened_at` on all N buckets forever, displacing each bucket's own
 * `low_sample`. Running it once per SERIES fixes both: N-1 duplicate queries disappear, and
 * `computeStatsSeries` places the reason only where the bucket has none of its own.
 */
const discloseUntimedIncidents: SeriesDisclosure = (db, cfg) => {
  if (cfg.pagerdutyServices.length === 0) return null;
  const ph = cfg.pagerdutyServices.map(() => "?").join(",");
  const untimed = db
    .query(
      `SELECT COUNT(*) AS c ${incidentScopeSql(ph)}
         AND json_extract(metadata, '$.opened_at_ms') IS NULL`,
    )
    .get(...cfg.pagerdutyServices) as { c: number } | null;
  return (untimed?.c ?? 0) > 0 ? "incidents_missing_opened_at" : null;
};

const STATS_METRICS: Readonly<Record<StatsMetricId, MetricEntry>> = {
  "deployment-frequency": { evaluate: wrapDora(deploymentFrequency) },
  "lead-time": { evaluate: wrapDora(leadTimeForChanges) },
  "change-failure-rate": { evaluate: wrapDora(changeFailureRate) },
  mttr: { evaluate: wrapDora(mttr) },
  "pr-merges": { evaluate: prMerges },
  "incidents-opened": { evaluate: incidentsOpened, disclose: discloseUntimedIncidents },
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
  const entry = STATS_METRICS[metric];
  const buckets = splitBuckets(untilMs, windowMs, bucketMs);
  // Computed ONCE, before the loop — never per bucket. See `discloseUntimedIncidents`.
  const disclosure = entry.disclose?.(db, cfg) ?? null;
  // A series-level disclosure fills only a bucket that derived NO reason of its own, so it
  // can never displace the more specific per-bucket `low_sample`. `b.startMs`/`b.endMs` are
  // the internal (camelCase) bucket bounds; `start_ms`/`end_ms` are the wire fields.
  const points: StatsPoint[] = buckets.map((b) => {
    const v = entry.evaluate(db, cfg, b.startMs, b.endMs);
    return { start_ms: b.startMs, end_ms: b.endMs, ...v, gap: v.gap ?? disclosure };
  });
  // ...and if EVERY bucket had a reason of its own, the disclosure would vanish from the
  // series entirely — which is precisely the case (nothing placeable anywhere) where it
  // matters most. So the newest bucket carries it as a last resort. Fail-loud, not silent.
  const last = points.length - 1;
  const lastPoint = points[last];
  if (disclosure !== null && lastPoint !== undefined && !points.some((p) => p.gap === disclosure)) {
    points[last] = { ...lastPoint, gap: disclosure };
  }
  return {
    metric,
    service: cfg.serviceId,
    window: { since_ms: untilMs - windowMs, until_ms: untilMs },
    bucket_ms: bucketMs,
    points,
  };
}
