import type { Database } from "bun:sqlite";
import { computeDoraMetrics, type DoraMetricsResult } from "../metrics/dora.ts";
import type { DoraServiceConfig } from "../metrics/dora-config.ts";

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
  loadConfig: () => Map<string, DoraServiceConfig>;
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
  method: string,
  params: unknown,
  ctx: MetricsRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DoraMetricsResult }> {
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
