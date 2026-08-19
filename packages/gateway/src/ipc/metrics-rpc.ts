import type { Database } from "bun:sqlite";
import { computeDoraMetrics, type DoraMetricsResult } from "../metrics/dora.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import {
  computeStatsSeries,
  STATS_METRIC_IDS,
  type StatsMetricId,
  type StatsSeries,
} from "../metrics/stats.ts";
import { StatsBucketError } from "../metrics/stats-buckets.ts";

export class MetricsRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "MetricsRpcError";
    this.rpcCode = rpcCode;
  }
}

export type MetricsRpcContext = {
  db: Database;
  loadConfig: () => Map<string, ServiceConfig>;
  nowMs?: () => number;
};

const MIN_SERVICE_LEN = 1;
const MAX_SERVICE_LEN = 64;
const DEFAULT_SINCE = "30d";

function parseSinceToMs(raw: string): number {
  const m = /^(\d+)([dh])$/.exec(raw);
  if (m === null) {
    throw new MetricsRpcError(-32602, String.raw`since must match \d+(d|h), got '${raw}'`);
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new MetricsRpcError(-32602, `since duration must be 1..365 ${m[2]}`);
  }
  return m[2] === "d" ? n * 86_400_000 : n * 3_600_000;
}

function requireDoraParams(params: unknown): { service: string; since: string } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new MetricsRpcError(-32602, "metrics.dora requires { service: string }");
  }
  const p = params as { service?: unknown; since?: unknown };
  if (typeof p.service !== "string") {
    throw new MetricsRpcError(-32602, "service must be a string");
  }
  const service = p.service.trim();
  if (service.length < MIN_SERVICE_LEN || service.length > MAX_SERVICE_LEN) {
    throw new MetricsRpcError(
      -32602,
      `service must be ${MIN_SERVICE_LEN}..${MAX_SERVICE_LEN} chars`,
    );
  }
  const since = p.since === undefined ? DEFAULT_SINCE : p.since;
  if (typeof since !== "string") {
    throw new MetricsRpcError(-32602, "since must be a string");
  }
  return { service, since };
}

function requireStatsParams(params: unknown): {
  service: string;
  metric: StatsMetricId;
  windowMs: number;
  bucketMs: number;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new MetricsRpcError(-32602, "metrics.stats requires an object");
  }
  const p = params as Record<string, unknown>;
  if (typeof p["service"] !== "string") {
    throw new MetricsRpcError(-32602, "service must be a string");
  }
  const service = p["service"].trim();
  if (service.length < MIN_SERVICE_LEN || service.length > MAX_SERVICE_LEN) {
    throw new MetricsRpcError(
      -32602,
      `service must be ${MIN_SERVICE_LEN}..${MAX_SERVICE_LEN} chars`,
    );
  }
  const metric = p["metric"];
  if (typeof metric !== "string" || !(STATS_METRIC_IDS as readonly string[]).includes(metric)) {
    throw new MetricsRpcError(-32602, `metric must be one of ${STATS_METRIC_IDS.join(", ")}`);
  }
  const windowMs = p["window_ms"];
  const bucketMs = p["bucket_ms"];
  if (!Number.isInteger(windowMs) || !Number.isInteger(bucketMs)) {
    throw new MetricsRpcError(-32602, "window_ms and bucket_ms must be integer milliseconds");
  }
  return {
    service,
    metric: metric as StatsMetricId,
    windowMs: windowMs as number,
    bucketMs: bucketMs as number,
  };
}

function unconfiguredEnvelope(service: string, sinceMs: number, nowMs: number): DoraMetricsResult {
  const placeholder = (unit: string) =>
    ({ value: null, unit, sample: 0, gap: "no_repos" as const }) as const;
  return {
    service,
    since_ms: sinceMs,
    computed_at: new Date(nowMs).toISOString(),
    metrics: {
      deployment_frequency: placeholder("deploys_per_day"),
      lead_time_for_changes: placeholder("seconds_median"),
      change_failure_rate: placeholder("ratio"),
      mttr: placeholder("seconds_median"),
    },
  };
}

export async function dispatchMetricsRpc(
  method: "metrics.dora",
  params: unknown,
  ctx: MetricsRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DoraMetricsResult }>;
export async function dispatchMetricsRpc(
  method: "metrics.stats",
  params: unknown,
  ctx: MetricsRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: StatsSeries }>;
export async function dispatchMetricsRpc(
  method: string,
  params: unknown,
  ctx: MetricsRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DoraMetricsResult | StatsSeries }>;
export async function dispatchMetricsRpc(
  method: string,
  params: unknown,
  ctx: MetricsRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DoraMetricsResult | StatsSeries }> {
  if (method === "metrics.stats") {
    const { service, metric, windowMs, bucketMs } = requireStatsParams(params);
    const nowMs = (ctx.nowMs ?? (() => Date.now()))();
    const cfg = ctx.loadConfig().get(service);
    if (cfg === undefined) {
      throw new MetricsRpcError(
        -32602,
        `unknown service '${service}' — add [metrics.dora.${service}] or [ci.service.${service}] to nimbus.toml`,
      );
    }
    try {
      return {
        kind: "hit",
        value: computeStatsSeries(ctx.db, cfg, metric, nowMs, windowMs, bucketMs),
      };
    } catch (e) {
      if (e instanceof StatsBucketError) throw new MetricsRpcError(-32602, e.message);
      throw e;
    }
  }
  if (method !== "metrics.dora") return { kind: "miss" };
  const { service, since } = requireDoraParams(params);
  const sinceMs = parseSinceToMs(since);
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  const configMap = ctx.loadConfig();
  const cfg = configMap.get(service);
  if (cfg === undefined) {
    return { kind: "hit", value: unconfiguredEnvelope(service, sinceMs, nowMs) };
  }
  return { kind: "hit", value: computeDoraMetrics(ctx.db, cfg, nowMs, sinceMs) };
}
