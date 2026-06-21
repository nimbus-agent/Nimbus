import { describe, expect, test } from "bun:test";

import {
  assertTelemetryPayloadSafe,
  buildTelemetryPreview,
  TelemetryPayloadUnsafeError,
} from "./collector.ts";

function validPayload(): Record<string, unknown> {
  return {
    session_id: "sess-1",
    nimbus_version: "0.13.1",
    platform: "linux",
    connector_error_rate: { github: 2 },
    connector_health_transitions: { healthy: 1 },
    query_latency_p50_ms: 10,
    query_latency_p95_ms: 20,
    query_latency_p99_ms: 30,
    agent_invocation_latency_p50_ms: 0,
    agent_invocation_latency_p95_ms: 0,
    sync_duration_p50_ms: { github: 5 },
    cold_start_ms: 0,
    extension_installs_by_id: { "ext.a": 1 },
    extension_uninstalls_by_id: {},
  };
}

describe("assertTelemetryPayloadSafe", () => {
  test("accepts a well-formed payload with strings, numbers, and nested objects", () => {
    expect(() => assertTelemetryPayloadSafe(validPayload())).not.toThrow();
  });

  test("rejects a non-object payload (null)", () => {
    expect(() => assertTelemetryPayloadSafe(null)).toThrow(TelemetryPayloadUnsafeError);
  });

  test("rejects a non-object payload (string)", () => {
    expect(() => assertTelemetryPayloadSafe("nope")).toThrow(
      "telemetry payload must be a plain object",
    );
  });

  test("rejects an array payload", () => {
    expect(() => assertTelemetryPayloadSafe([])).toThrow(TelemetryPayloadUnsafeError);
  });

  test("rejects an unexpected top-level key", () => {
    const p = validPayload();
    p["surprise"] = 1;
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("unexpected telemetry top-level key");
  });

  test("rejects a payload missing a required top-level key", () => {
    const p = validPayload();
    delete p["cold_start_ms"];
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("missing telemetry top-level key");
  });

  test("rejects a string value that looks like a Bearer token", () => {
    const p = validPayload();
    p["nimbus_version"] = "Bearer abc123def";
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("looks like a credential");
  });

  test("rejects a string value that looks like an sk- API key", () => {
    const p = validPayload();
    p["session_id"] = "sk-abcdefghij1234567890";
    expect(() => assertTelemetryPayloadSafe(p)).toThrow(TelemetryPayloadUnsafeError);
  });

  test("rejects a string value that looks like a PEM private key", () => {
    const p = validPayload();
    p["session_id"] = "-----BEGIN RSA PRIVATE KEY-----";
    expect(() => assertTelemetryPayloadSafe(p)).toThrow(TelemetryPayloadUnsafeError);
  });

  test("rejects a nested object key that looks unsafe", () => {
    const p = validPayload();
    p["connector_error_rate"] = { secret_value: 1 };
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("telemetry payload key is not allowed");
  });

  test("walks array values recursively and accepts safe entries", () => {
    const p = validPayload();
    p["connector_error_rate"] = { items: [1, "ok", null, true] };
    expect(() => assertTelemetryPayloadSafe(p)).not.toThrow();
  });

  test("rejects an unsafe string nested inside an array value", () => {
    const p = validPayload();
    p["connector_error_rate"] = { items: ["Bearer leakedtoken123"] };
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("looks like a credential");
  });

  test("rejects an unsupported value type (undefined)", () => {
    const p = validPayload();
    p["cold_start_ms"] = undefined;
    expect(() => assertTelemetryPayloadSafe(p)).toThrow("telemetry payload has unsupported type");
  });
});

describe("buildTelemetryPreview", () => {
  test("produces a payload that passes the safety assertion (no db)", () => {
    const preview = buildTelemetryPreview({
      nimbusVersion: "0.13.1",
      queryLatencyP50Ms: 11,
      queryLatencyP95Ms: 22,
      queryLatencyP99Ms: 33,
    });
    expect(preview.nimbus_version).toBe("0.13.1");
    expect(preview.query_latency_p50_ms).toBe(11);
    expect(preview.query_latency_p95_ms).toBe(22);
    expect(preview.query_latency_p99_ms).toBe(33);
    expect(preview.session_id).toBe("preview-not-persisted");
    expect(preview.cold_start_ms).toBe(0);
    expect(["win32", "darwin", "linux"]).toContain(preview.platform);
    expect(() => assertTelemetryPayloadSafe(preview)).not.toThrow();
  });

  test("honors an explicit sessionId and rounds a finite coldStartMs", () => {
    const preview = buildTelemetryPreview({
      nimbusVersion: "0.13.1",
      queryLatencyP50Ms: 1,
      queryLatencyP95Ms: 2,
      queryLatencyP99Ms: 3,
      sessionId: "real-session",
      coldStartMs: 42.7,
    });
    expect(preview.session_id).toBe("real-session");
    expect(preview.cold_start_ms).toBe(43);
  });

  test("falls back to 0 for a non-finite coldStartMs", () => {
    const preview = buildTelemetryPreview({
      nimbusVersion: "0.13.1",
      queryLatencyP50Ms: 1,
      queryLatencyP95Ms: 2,
      queryLatencyP99Ms: 3,
      coldStartMs: Number.POSITIVE_INFINITY,
    });
    expect(preview.cold_start_ms).toBe(0);
  });
});
