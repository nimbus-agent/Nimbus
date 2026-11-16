// Rows are written by the REAL mapper, rollup and upsert (spec section 5.1).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initLayeredConfig, resetLayeredConfigsForTests } from "../config/layered-config.ts";
import { costAllocationItem, mapVantageCostRow } from "../connectors/vantage-cost-mapping.ts";
import type { CostAnomalyResult } from "../finops/cost-anomaly-query.ts";
import { type CostPoint, DAY_MS } from "../finops/cost-item-contract.ts";
import { rollUpCostPoints } from "../finops/cost-rollup.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { CostRpcError, dispatchCostRpc } from "./cost-rpc.ts";

const SYNCED = Date.UTC(2026, 10, 12, 6);
const DAY0 = Date.UTC(2026, 10, 1);
const origFetch = globalThis.fetch;

let db: Database;
let dir: string;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-rpc-"));
  globalThis.fetch = (() => {
    throw new Error("cost.anomalies must never make a network call");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  resetLayeredConfigsForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function indexSpike(): void {
  const amounts = [10, 10, 10, 10, 10, 10, 10, 25, 1, 1, 1];
  const rows = amounts.map((a, d) => ({
    accrued_at: new Date(DAY0 + d * DAY_MS).toISOString().slice(0, 10),
    amount: String(a),
    currency: "USD",
    service: "EC2",
  }));
  const ctx = { scopeId: "default", groupBy: ["service"] as readonly string[] };
  const points = rows
    .map((r) => mapVantageCostRow(r, ctx))
    .filter((p): p is CostPoint => p !== null);
  for (const r of rollUpCostPoints(points, {
    service: "vantage",
    scopeId: "default",
    maxSeries: 500,
    existingSeriesHashes: new Set(),
    syncedAt: SYNCED,
  })) {
    upsertIndexedItem(db, costAllocationItem(r, SYNCED));
  }
}

async function call(params: unknown, configDir?: string): Promise<CostAnomalyResult> {
  const out = await dispatchCostRpc("cost.anomalies", params, {
    db,
    now: () => SYNCED,
    ...(configDir === undefined ? {} : { configDir }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as CostAnomalyResult;
}

describe("cost.anomalies", () => {
  test("an empty index is no_data and a miss on another method", async () => {
    expect((await call(undefined)).status).toBe("no_data");
    expect((await dispatchCostRpc("cost.other", {}, { db })).kind).toBe("miss");
  });

  test("defaults: a 2.5x day over a 15 excess is flagged with the default thresholds", async () => {
    indexSpike();
    const r = await call({});
    expect(r.status).toBe("anomalies");
    expect(r.thresholds).toEqual({ ratio: 1.5, minAmount: 10 });
    expect(r.anomalies[0]).toMatchObject({ name: "EC2", amount: 25, baselineMean: 10 });
  });

  test("[finops] thresholds are read from the config dir", async () => {
    indexSpike();
    writeFileSync(join(dir, "nimbus.toml"), "[finops]\nanomaly_min_amount = 20\n");
    initLayeredConfig(dir);
    const r = await call({ service: "vantage", days: 1 }, dir);
    expect(r.thresholds).toEqual({ ratio: 1.5, minAmount: 20 });
    expect(r.status).toBe("ok");
  });

  test.each([
    ["a string payload", "x"],
    ["an array payload", []],
    ["null", null],
    ["an unknown key", { nope: 1 }],
    ["a non-cost service", { service: "github" }],
    ["a non-string service", { service: 3 }],
    ["days 0", { days: 0 }],
    ["days 31", { days: 31 }],
    ["fractional days", { days: 1.5 }],
    ["string days", { days: "2" }],
  ])("%s is -32602", async (_name, params) => {
    const err = await call(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostRpcError);
    expect((err as CostRpcError).rpcCode).toBe(-32602);
  });
});
