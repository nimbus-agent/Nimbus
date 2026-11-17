import type { Database } from "bun:sqlite";

import type { NimbusIncidentPredictToml } from "../config/incident-predict-toml.ts";
import { queryOncallNow } from "../index/oncall-now-query.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import {
  BASELINE_WINDOW_MS,
  BUCKET_MS,
  bucketStart,
  isAnomalous,
  scoreBucket,
} from "./anomaly-baseline.ts";
import { countIndexBuckets, INDEX_METRICS, indexSeriesId } from "./anomaly-series.ts";
import {
  clearFinding,
  FINDING_CLEARED_RETENTION_MS,
  newestBucketMs,
  openFinding,
  openFindingKeys,
  pruneBaselineBuckets,
  pruneClearedFindings,
  readBaselineBuckets,
  writeBaselineBuckets,
} from "./finding-store.ts";
import { evaluateRadar } from "./radar.ts";
import { radarReader } from "./radar-read.ts";

/**
 * The predict pass (Phase 10 IC8, incident-engine spec § 5.8), every {@link PREDICT_INTERVAL_MS} and once at
 * boot: the expectation radar, then the index anomaly baseline. It reads the local index and writes only its own
 * tables through `finding-store.ts` (D46(f)); it dispatches nothing, posts nothing and makes no request (D-IC-5,
 * I57 (a), D46(a)). Its only outward effects are a local OS notification with COUNTS only (never a title, a
 * service or a connector) and the `incident.finding` gateway event, both injected; a demo gateway passes no
 * `notify` (I41).
 *
 * The baseline writes every completed hour that ended at least {@link SETTLE_MS} ago (a sync-lag allowance: an
 * item indexed later than its opened hour would otherwise be missed), backfilled at most 14 days, then scores the
 * newest bucket of each series. The anomaly heads-up toast is raised only for a NEW finding on a service the owner
 * is on call for now (MB3's indexed shifts); every other new finding is recorded only.
 */

export const PREDICT_INTERVAL_MS = 15 * 60_000;
export const SETTLE_MS = 60 * 60_000;

export type PredictPassDeps = {
  readonly db: Database;
  readonly config: () => NimbusIncidentPredictToml;
  /** The `[ci.service.*]` services; a throw (a malformed block) skips the parts that need them. */
  readonly serviceConfigs: () => ReadonlyMap<string, ServiceConfig>;
  readonly nowMs: () => number;
  /** The OS notification (`showIgnoringFailure`); absent on a demo gateway (I41). */
  readonly notify?: (title: string, body: string) => void;
  readonly emit?: (payload: { readonly opened: number; readonly cleared: number }) => void;
  /** Test seam; defaults to the indexed shifts (`queryOncallNow`'s `youAreOnCall`). */
  readonly isOwnerOnCallFor?: (serviceId: string, nowMs: number) => boolean;
};

export type PredictPassResult = {
  readonly radar: { readonly opened: number; readonly cleared: number; readonly unknown: number };
  readonly anomaly: { readonly opened: number; readonly cleared: number; readonly headsUp: number };
  readonly bucketsWritten: number;
  /** True when a capped scan left this pass's range unwritten, or the service configs did not load. */
  readonly gap: boolean;
};

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function runRadar(
  deps: PredictPassDeps,
  cfg: NimbusIncidentPredictToml,
  configs: ReadonlyMap<string, ServiceConfig>,
  now: number,
): PredictPassResult["radar"] {
  const verdicts = evaluateRadar(cfg.expectations, radarReader(deps.db, configs), now);
  let opened = 0;
  let cleared = 0;
  let unknown = 0;
  for (const v of verdicts) {
    const e = v.expectation;
    if (v.state === "unknown") {
      unknown += 1;
    } else if (v.state === "overdue") {
      const isNew = openFinding(deps.db, {
        kind: "radar",
        key: e.key,
        service: e.service,
        detail: { kind: e.kind, type: e.type, maxGapMs: e.maxGapMs, lastAtMs: v.lastAtMs },
        nowMs: now,
      });
      if (isNew) opened += 1;
    } else if (clearFinding(deps.db, "radar", e.key, now)) {
      cleared += 1;
    }
  }
  // An expectation removed from nimbus.toml no longer applies: its open finding clears.
  const configured = new Set(cfg.expectations.map((e) => e.key));
  for (const key of openFindingKeys(deps.db, "radar")) {
    if (!configured.has(key) && clearFinding(deps.db, "radar", key, now)) cleared += 1;
  }
  return { opened, cleared, unknown };
}

function defaultOnCall(
  db: Database,
  configs: ReadonlyMap<string, ServiceConfig>,
): (serviceId: string, nowMs: number) => boolean {
  const bindings = [...configs.values()].map((c) => ({
    serviceId: c.serviceId,
    pagerdutyServices: c.pagerdutyServices,
  }));
  return (serviceId, nowMs) =>
    queryOncallNow(db, { nowMs, term: serviceId, serviceConfigs: bindings }).youAreOnCall;
}

function runBaseline(
  deps: PredictPassDeps,
  cfg: NimbusIncidentPredictToml,
  configs: ReadonlyMap<string, ServiceConfig>,
  now: number,
): { anomaly: PredictPassResult["anomaly"]; bucketsWritten: number; gap: boolean } {
  const end = bucketStart(now - SETTLE_MS);
  const newest = newestBucketMs(deps.db, "index:");
  const start = Math.max(
    newest === null ? end - BASELINE_WINDOW_MS : newest + BUCKET_MS,
    end - BASELINE_WINDOW_MS,
  );
  let bucketsWritten = 0;
  let gap = false;
  if (start < end) {
    const counted = countIndexBuckets(deps.db, configs, start, end);
    if (counted.kind === "capped") {
      gap = true;
    } else {
      writeBaselineBuckets(deps.db, counted.buckets);
      bucketsWritten = counted.buckets.length;
    }
  }
  const scored = end - BUCKET_MS;
  const onCall = deps.isOwnerOnCallFor ?? defaultOnCall(deps.db, configs);
  const live = new Set<string>();
  let opened = 0;
  let cleared = 0;
  let headsUp = 0;
  for (const serviceId of configs.keys()) {
    for (const metric of INDEX_METRICS) {
      const seriesId = indexSeriesId(metric, serviceId);
      live.add(seriesId);
      const rows = readBaselineBuckets(deps.db, seriesId, scored - BASELINE_WINDOW_MS, scored);
      const last = rows.at(-1);
      if (last?.bucketStartMs !== scored) continue;
      const score = scoreBucket(
        rows.slice(0, -1).map((r) => r.value),
        last.value,
      );
      if (score !== null && isAnomalous(score, last.value, cfg.anomalyZ)) {
        const isNew = openFinding(deps.db, {
          kind: "anomaly",
          key: seriesId,
          service: serviceId,
          detail: {
            metric,
            bucketStartMs: scored,
            value: last.value,
            mean: Math.round(score.mean * 100) / 100,
            z: Math.round(score.z * 10) / 10,
            baselineBuckets: score.baselineBuckets,
          },
          nowMs: now,
        });
        if (isNew) {
          opened += 1;
          if (onCall(serviceId, now)) headsUp += 1;
        }
      } else if (clearFinding(deps.db, "anomaly", seriesId, now)) {
        cleared += 1;
      }
    }
  }
  // A service removed from nimbus.toml: its open index findings clear (sync findings are not this pass's).
  for (const key of openFindingKeys(deps.db, "anomaly")) {
    if (key.startsWith("index:") && !live.has(key) && clearFinding(deps.db, "anomaly", key, now)) {
      cleared += 1;
    }
  }
  pruneBaselineBuckets(deps.db, scored - BASELINE_WINDOW_MS);
  return { anomaly: { opened, cleared, headsUp }, bucketsWritten, gap };
}

/** One pass. Throws only on a database error; the scheduler catches it. */
export function runPredictPass(deps: PredictPassDeps): PredictPassResult {
  const now = deps.nowMs();
  const cfg = deps.config();
  let configs: ReadonlyMap<string, ServiceConfig>;
  let configsGap = false;
  try {
    configs = deps.serviceConfigs();
  } catch {
    configs = new Map();
    configsGap = true;
  }
  const radar = runRadar(deps, cfg, configs, now);
  const base = configsGap
    ? { anomaly: { opened: 0, cleared: 0, headsUp: 0 }, bucketsWritten: 0, gap: true }
    : runBaseline(deps, cfg, configs, now);
  pruneClearedFindings(deps.db, now - FINDING_CLEARED_RETENTION_MS);

  if (deps.notify !== undefined) {
    if (radar.opened > 0) {
      deps.notify(
        "Nimbus",
        `${plural(radar.opened, "expected event is", "expected events are")} overdue (nimbus incident findings)`,
      );
    }
    if (base.anomaly.headsUp > 0) {
      deps.notify(
        "Nimbus",
        `${plural(base.anomaly.headsUp, "unusual signal", "unusual signals")} on a service you are on call for (nimbus incident findings)`,
      );
    }
  }
  const opened = radar.opened + base.anomaly.opened;
  const cleared = radar.cleared + base.anomaly.cleared;
  if (opened + cleared > 0) deps.emit?.({ opened, cleared });
  return { radar, anomaly: base.anomaly, bucketsWritten: base.bucketsWritten, gap: base.gap };
}

export type PredictTimer = { readonly clear: () => void };

export type PredictSchedulerOptions = PredictPassDeps & {
  readonly setTimer?: (fn: () => void, ms: number) => PredictTimer;
  readonly onError?: (err: unknown) => void;
};

export type PredictSchedulerHandle = {
  readonly stop: () => void;
  /** Resolves when the pass in flight (if any) has finished. */
  readonly idle: () => Promise<void>;
};

function defaultSetTimer(fn: () => void, ms: number): PredictTimer {
  const t = setInterval(fn, ms);
  return { clear: () => clearInterval(t) };
}

/** One pass at start, then every 15 minutes; single-flight; a failing pass is reported, never thrown. */
export function startPredictScheduler(opts: PredictSchedulerOptions): PredictSchedulerHandle {
  const setTimer = opts.setTimer ?? defaultSetTimer;
  let inFlight: Promise<void> | undefined;
  const tick = (): void => {
    if (inFlight !== undefined) return;
    inFlight = Promise.resolve()
      .then(() => {
        runPredictPass(opts);
      })
      .catch((err: unknown) => opts.onError?.(err))
      .finally(() => {
        inFlight = undefined;
      });
  };
  tick();
  const timer = setTimer(tick, PREDICT_INTERVAL_MS);
  return { stop: () => timer.clear(), idle: async () => inFlight };
}
