import type { Database } from "bun:sqlite";

import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { BUCKET_MS } from "./anomaly-baseline.ts";
import type { BaselineBucket } from "./finding-store.ts";
import { triggerFacts } from "./trigger-facts.ts";
import type { TriggerService } from "./trigger-sources.ts";

/**
 * The index anomaly series (Phase 10 IC8): per configured service, hourly counts of new error issues (Sentry), new
 * alerts (PagerDuty incidents and JSM alerts) and failed CI runs, from the local index only (D46(a)). A trigger is
 * counted in the hour of its OPENED time (`trigger-facts`, the engine's one reader of those keys), bound to a
 * service by the identity resolver; a CI run in the hour of its `modified_at` when its canonical `conclusion` is
 * `failure`. Every (series, hour) of the range is returned, zeros included. A scan cut by its cap returns `capped`
 * and nothing else, so the caller writes no bucket for the range (a gap, never a false zero).
 */

export type IndexMetric = "errors" | "alerts" | "ci_failed";
export const INDEX_METRICS: readonly IndexMetric[] = ["errors", "alerts", "ci_failed"];
export const SERIES_SCAN_CAP = 20_000;

export function indexSeriesId(metric: IndexMetric, serviceId: string): string {
  return `index:${metric}:${serviceId}`;
}

type Row = { service: string; type: string; metadata: string | null; modified_at: number };

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const METRIC_OF_TRIGGER: Readonly<Record<string, IndexMetric>> = {
  "sentry/error_issue": "errors",
  "pagerduty/incident": "alerts",
  "jira/alert": "alerts",
};

export function countIndexBuckets(
  db: Database,
  configs: ReadonlyMap<string, ServiceConfig>,
  fromMs: number,
  toMs: number,
  cap: number = SERIES_SCAN_CAP,
): { readonly kind: "ok"; readonly buckets: BaselineBucket[] } | { readonly kind: "capped" } {
  const triggers = db
    .query(
      `SELECT service, type, metadata, modified_at FROM item
        WHERE ((service = 'sentry' AND type = 'error_issue') OR (service = 'pagerduty' AND type = 'incident')
               OR (service = 'jira' AND type = 'alert'))
          AND modified_at >= ?
        LIMIT ?`,
    )
    .all(fromMs, cap + 1) as Row[];
  const runs = db
    .query(
      `SELECT service, type, metadata, modified_at FROM item
        WHERE type = 'ci_run' AND modified_at >= ? AND modified_at < ? LIMIT ?`,
    )
    .all(fromMs, toMs, cap + 1) as Row[];
  if (triggers.length > cap || runs.length > cap) return { kind: "capped" };

  const counts = new Map<string, number>();
  for (const serviceId of configs.keys()) {
    for (const metric of INDEX_METRICS) {
      for (let b = fromMs; b < toMs; b += BUCKET_MS) counts.set(`${indexSeriesId(metric, serviceId)}\u0000${String(b)}`, 0);
    }
  }
  const resolve = buildServiceIdentityResolver(configs);
  const bump = (metric: IndexMetric, serviceId: string, atMs: number): void => {
    if (atMs < fromMs || atMs >= toMs) return;
    const b = fromMs + Math.floor((atMs - fromMs) / BUCKET_MS) * BUCKET_MS;
    const key = `${indexSeriesId(metric, serviceId)}\u0000${String(b)}`;
    const prev = counts.get(key);
    if (prev !== undefined) counts.set(key, prev + 1);
  };
  for (const r of triggers) {
    const metric = METRIC_OF_TRIGGER[`${r.service}/${r.type}`];
    if (metric === undefined) continue;
    const facts = triggerFacts({ service: r.service as TriggerService, metadata: r.metadata });
    if (facts.openedAtMs === null) continue;
    const meta = parseMeta(r.metadata);
    if (meta === null) continue;
    const res = resolve({ service: r.service, type: r.type, metadata: meta });
    if (res.kind === "bound") bump(metric, res.serviceId, facts.openedAtMs);
  }
  for (const r of runs) {
    const meta = parseMeta(r.metadata);
    // lane-census: scope=ci_run
    if (meta === null || meta["conclusion"] !== "failure") continue;
    const res = resolve({ service: r.service, type: "ci_run", metadata: meta });
    if (res.kind === "bound") bump("ci_failed", res.serviceId, r.modified_at);
  }
  const buckets: BaselineBucket[] = [];
  for (const [key, value] of counts) {
    const [seriesId, b] = key.split("\u0000") as [string, string];
    buckets.push({ seriesId, bucketStartMs: Number(b), value });
  }
  return { kind: "ok", buckets };
}
