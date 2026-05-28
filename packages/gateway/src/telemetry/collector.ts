import type { Database } from "bun:sqlite";

import { collectTelemetryDbAggregates } from "./db-aggregates.ts";

const TELEMETRY_TOP_LEVEL_KEYS = new Set([
  "session_id",
  "nimbus_version",
  "platform",
  "connector_error_rate",
  "connector_health_transitions",
  "query_latency_p50_ms",
  "query_latency_p95_ms",
  "query_latency_p99_ms",
  "agent_invocation_latency_p50_ms",
  "agent_invocation_latency_p95_ms",
  "sync_duration_p50_ms",
  "cold_start_ms",
  "extension_installs_by_id",
  "extension_uninstalls_by_id",
]);

const FORBIDDEN_KEY_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "cookie",
] as const;

export class TelemetryPayloadUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryPayloadUnsafeError";
  }
}

function keyLooksUnsafe(k: string): boolean {
  const lower = k.toLowerCase();
  for (const frag of FORBIDDEN_KEY_SUBSTRINGS) {
    if (lower.includes(frag)) {
      return true;
    }
  }
  return false;
}

function assertTelemetryValueSafe(v: unknown, path: string): void {
  if (v === null || typeof v === "number" || typeof v === "boolean") {
    return;
  }
  if (typeof v === "string") {
    const s = v;
    if (
      /Bearer\s+\S+/i.test(s) ||
      /sk-[a-zA-Z0-9]{10,}/.test(s) ||
      /BEGIN [A-Z ]+PRIVATE KEY/.test(s)
    ) {
      throw new TelemetryPayloadUnsafeError(
        `telemetry payload string at ${path} looks like a credential`,
      );
    }
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      assertTelemetryValueSafe(v[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (typeof v === "object") {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (keyLooksUnsafe(k)) {
        throw new TelemetryPayloadUnsafeError(`telemetry payload key is not allowed: ${path}.${k}`);
      }
      assertTelemetryValueSafe(child, `${path}.${k}`);
    }
    return;
  }
  throw new TelemetryPayloadUnsafeError(`telemetry payload has unsupported type at ${path}`);
}

export function assertTelemetryPayloadSafe(payload: unknown): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TelemetryPayloadUnsafeError("telemetry payload must be a plain object");
  }
  const o = payload as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!TELEMETRY_TOP_LEVEL_KEYS.has(k)) {
      throw new TelemetryPayloadUnsafeError(`unexpected telemetry top-level key: ${k}`);
    }
    if (keyLooksUnsafe(k)) {
      throw new TelemetryPayloadUnsafeError(`telemetry top-level key is not allowed: ${k}`);
    }
  }
  for (const k of TELEMETRY_TOP_LEVEL_KEYS) {
    if (!(k in o)) {
      throw new TelemetryPayloadUnsafeError(`missing telemetry top-level key: ${k}`);
    }
    assertTelemetryValueSafe(o[k], k);
  }
}

export type TelemetryPreviewPayload = {
  session_id: string;
  nimbus_version: string;
  platform: "win32" | "darwin" | "linux";
  connector_error_rate: Record<string, number>;
  connector_health_transitions: Record<string, number>;
  query_latency_p50_ms: number;
  query_latency_p95_ms: number;
  query_latency_p99_ms: number;
  agent_invocation_latency_p50_ms: number;
  agent_invocation_latency_p95_ms: number;
  sync_duration_p50_ms: Record<string, number>;
  cold_start_ms: number;
  extension_installs_by_id: Record<string, number>;
  extension_uninstalls_by_id: Record<string, number>;
};

export function buildTelemetryPreview(params: {
  nimbusVersion: string;
  queryLatencyP50Ms: number;
  queryLatencyP95Ms: number;
  queryLatencyP99Ms: number;
  sessionId?: string;
  db?: Database;
  coldStartMs?: number;
}): TelemetryPreviewPayload {
  const plat = process.platform;
  const platform: TelemetryPreviewPayload["platform"] =
    plat === "win32" || plat === "darwin" || plat === "linux" ? plat : "linux";
  const out: TelemetryPreviewPayload = {
    session_id: params.sessionId ?? "preview-not-persisted",
    nimbus_version: params.nimbusVersion,
    platform,
    connector_error_rate: {},
    connector_health_transitions: {},
    query_latency_p50_ms: params.queryLatencyP50Ms,
    query_latency_p95_ms: params.queryLatencyP95Ms,
    query_latency_p99_ms: params.queryLatencyP99Ms,
    agent_invocation_latency_p50_ms: 0,
    agent_invocation_latency_p95_ms: 0,
    sync_duration_p50_ms: {},
    cold_start_ms:
      params.coldStartMs !== undefined && Number.isFinite(params.coldStartMs)
        ? Math.max(0, Math.round(params.coldStartMs))
        : 0,
    extension_installs_by_id: {},
    extension_uninstalls_by_id: {},
  };
  if (params.db !== undefined) {
    const ag = collectTelemetryDbAggregates(params.db);
    Object.assign(out.connector_error_rate, ag.connector_error_rate);
    Object.assign(out.connector_health_transitions, ag.connector_health_transitions);
    Object.assign(out.sync_duration_p50_ms, ag.sync_duration_p50_ms);
    Object.assign(out.extension_installs_by_id, ag.extension_installs_by_id);
  }
  assertTelemetryPayloadSafe(out);
  return out;
}
