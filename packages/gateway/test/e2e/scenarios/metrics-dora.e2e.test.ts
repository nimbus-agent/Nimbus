import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchMetricsRpc } from "../../../src/ipc/metrics-rpc.ts";
import type { DoraMetricsResult } from "../../../src/metrics/dora.ts";
import {
  FIXTURE_NOW_MS,
  seedPaymentServiceFixture,
} from "../../fixtures/dora/payment-service/seed.ts";

const TARGET_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

describe("nimbus metrics dora (e2e, in-process)", () => {
  test("returns the four-metric envelope for a configured service", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA_VERSION);
    const { config } = await seedPaymentServiceFixture(db);

    const out = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "payment-service", since: "30d" },
      {
        db,
        loadConfig: () => new Map([[config.serviceId, config]]),
        nowMs: () => FIXTURE_NOW_MS,
      },
    );

    if (out.kind !== "hit") throw new Error("expected hit");
    const result: DoraMetricsResult = out.value;

    expect(result.service).toBe("payment-service");
    expect(result.since_ms).toBe(30 * 86_400_000);
    expect(Object.keys(result.metrics).sort((a, b) => a.localeCompare(b))).toEqual([
      "change_failure_rate",
      "deployment_frequency",
      "lead_time_for_changes",
      "mttr",
    ]);
    expect(result.metrics.deployment_frequency.unit).toBe("deploys_per_day");
    expect(result.metrics.lead_time_for_changes.unit).toBe("seconds_median");
    expect(result.metrics.change_failure_rate.unit).toBe("ratio");
    expect(result.metrics.mttr.unit).toBe("seconds_median");
    expect(result.metrics.deployment_frequency.sample).toBe(13);
    expect(result.metrics.mttr.sample).toBe(4);
    expect(result.metrics.deployment_frequency.value).not.toBeNull();

    db.close();
  });

  test("returns null-everywhere envelope with gap='no_repos' when the service is not configured", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, TARGET_SCHEMA_VERSION);

    const out = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "unknown-svc", since: "30d" },
      {
        db,
        loadConfig: () => new Map(),
        nowMs: () => FIXTURE_NOW_MS,
      },
    );

    if (out.kind !== "hit") throw new Error("expected hit");
    const metrics = out.value.metrics;
    expect(metrics.deployment_frequency).toEqual({
      value: null,
      unit: "deploys_per_day",
      sample: 0,
      gap: "no_repos",
    });
    expect(metrics.lead_time_for_changes).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_repos",
    });
    expect(metrics.change_failure_rate).toEqual({
      value: null,
      unit: "ratio",
      sample: 0,
      gap: "no_repos",
    });
    expect(metrics.mttr).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_repos",
    });

    db.close();
  });
});
