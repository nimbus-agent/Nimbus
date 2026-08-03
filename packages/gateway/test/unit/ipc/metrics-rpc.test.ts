import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { dispatchMetricsRpc, MetricsRpcError } from "../../../src/ipc/metrics-rpc.ts";
import {
  FIXTURE_NOW_MS,
  seedPaymentServiceFixture,
} from "../../fixtures/dora/payment-service/seed.ts";
import { openSeededDbFile } from "../../helpers/migrated-db-seed.ts";

describe("metrics-rpc", () => {
  let dir: string;
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-metrics-rpc-"));
    db = openSeededDbFile(join(dir, "nimbus.db"), CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => {
    db.close();
    try {
      // maxRetries: 0 / retryDelay: 0 — a pinned handle must fail FAST rather than block
      // the hook's timeout budget; a leaked temp dir is the accepted trade-off (#972,
      // #973). Do NOT turn this back into a blocking retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("dispatches metrics.dora with a fixture-seeded service", async () => {
    const { config } = await seedPaymentServiceFixture(db);
    const out = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "payment-service", since: "30d" },
      { db, loadConfig: () => new Map([[config.serviceId, config]]), nowMs: () => FIXTURE_NOW_MS },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    const result = out.value;
    expect(result.service).toBe("payment-service");
  });

  it("returns null-everywhere envelope when service id has no config", async () => {
    const out = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "unknown", since: "30d" },
      { db, loadConfig: () => new Map(), nowMs: () => FIXTURE_NOW_MS },
    );
    if (out.kind !== "hit") throw new Error("expected hit");
    const m = out.value.metrics;
    expect(m.deployment_frequency).toEqual({
      value: null,
      unit: "deploys_per_day",
      sample: 0,
      gap: "no_repos",
    });
    expect(m.lead_time_for_changes).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_repos",
    });
    expect(m.change_failure_rate).toEqual({
      value: null,
      unit: "ratio",
      sample: 0,
      gap: "no_repos",
    });
    expect(m.mttr).toEqual({
      value: null,
      unit: "seconds_median",
      sample: 0,
      gap: "no_repos",
    });
  });

  it("rejects array params with -32602", async () => {
    await expect(
      dispatchMetricsRpc("metrics.dora", [{ service: "x" }], {
        db,
        loadConfig: () => new Map(),
        nowMs: () => FIXTURE_NOW_MS,
      }),
    ).rejects.toThrow(MetricsRpcError);
  });

  it("rejects missing service param", async () => {
    await expect(
      dispatchMetricsRpc(
        "metrics.dora",
        { since: "30d" },
        { db, loadConfig: () => new Map(), nowMs: () => FIXTURE_NOW_MS },
      ),
    ).rejects.toThrow(/service/);
  });

  it("returns miss for an unknown method", async () => {
    const out = await dispatchMetricsRpc(
      "metrics.unknown",
      {},
      { db, loadConfig: () => new Map(), nowMs: () => FIXTURE_NOW_MS },
    );
    expect(out.kind).toBe("miss");
  });

  it("parses since='7d' correctly", async () => {
    const { config } = await seedPaymentServiceFixture(db);
    const sevenDay = await dispatchMetricsRpc(
      "metrics.dora",
      { service: "payment-service", since: "7d" },
      { db, loadConfig: () => new Map([[config.serviceId, config]]), nowMs: () => FIXTURE_NOW_MS },
    );
    if (sevenDay.kind !== "hit") throw new Error("expected hit");
    expect(sevenDay.value.since_ms).toBe(7 * 86_400_000);
  });
});
