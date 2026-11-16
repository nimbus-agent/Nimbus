import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import {
  HOUR,
  resolverFor,
  serviceConfig,
  T0,
  writeMergedPr,
} from "../__fixtures__/index-writers.ts";
import { dataLane, dataSubstrateGaps, holdsToken, modelToken } from "./data.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const resolver = resolverFor(serviceConfig());
const OPEN = T0 + 6 * HOUR;
const MODEL = "analytics.payments.orders";

function put(
  d: Database,
  service: string,
  type: string,
  externalId: string,
  title: string,
): string {
  upsertIndexedItem(
    d,
    {
      service,
      type,
      externalId,
      title,
      bodyPreview: "",
      modifiedAt: T0,
      syncedAt: T0,
      metadata: {},
    },
    resolver,
  );
  return `${service}:${externalId}`;
}

function model(d: Database, key: string, derivedFrom: string[]): void {
  upsertIndexedItem(
    d,
    {
      service: "snowflake",
      type: "data_model",
      externalId: key,
      title: key,
      bodyPreview: "",
      modifiedAt: T0,
      syncedAt: T0,
      metadata: { dataModelKey: key, derivedFromKeys: derivedFrom },
    },
    resolver,
  );
}

describe("whole-token matching", () => {
  test("orders matches orders and orders_daily, not reorders", () => {
    expect(holdsToken("Refresh orders", "orders")).toBe(true);
    expect(holdsToken("orders_daily load", "orders")).toBe(true);
    expect(holdsToken("(orders)", "orders")).toBe(true);
    expect(holdsToken("reorders nightly", "orders")).toBe(false);
    expect(holdsToken("orders2", "orders")).toBe(false);
    expect(holdsToken("reorders then orders", "orders")).toBe(true);
    expect(modelToken("analytics.payments.orders")).toBe("orders");
    expect(modelToken("a.b.id")).toBeNull();
  });
});

describe("lane 6, data", () => {
  test("lineage one hop, name-matched orchestration, merged PRs by title and branch; rules on every entry", () => {
    const d = db();
    model(d, MODEL, ["raw.payments.orders_raw", "raw.payments.fx"]);
    const dbt = put(d, "dbt", "job", "1:10", "Nightly orders refresh");
    const airflow = put(d, "airflow", "dag", "orders_etl", "orders_etl: load orders");
    put(d, "dagster", "job", "j1", "reorders cleanup");
    const prefect = put(d, "prefect", "deployment", "p1", "orders backfill");
    const byTitle = writeMergedPr(d, resolver, {
      number: 1,
      title: "Fix orders rounding",
      mergedAtMs: OPEN - HOUR,
      sha: "c1".repeat(20),
    });
    const byBranch = writeMergedPr(d, resolver, {
      number: 2,
      title: "Refactor",
      branch: "feature/orders-fix",
      mergedAtMs: OPEN - 2 * HOUR,
      sha: "c2".repeat(20),
    });
    writeMergedPr(d, resolver, {
      number: 3,
      title: "Fix orders",
      mergedAtMs: OPEN - 30 * HOUR,
      sha: "c3".repeat(20),
    });
    writeMergedPr(d, resolver, {
      number: 4,
      title: "Fix reorders",
      mergedAtMs: OPEN - HOUR,
      sha: "c4".repeat(20),
    });
    const r = dataLane(d, { metadata: { monitoredDataModelKeys: [MODEL] }, openedAtMs: OPEN });
    expect(r.lane.models).toEqual([MODEL]);
    expect(r.lane.lineage.map((l) => l.to)).toEqual(["raw.payments.fx", "raw.payments.orders_raw"]);
    expect(r.lane.lineage.every((l) => l.rule === "data:derived_from")).toBe(true);
    expect(new Set(r.lane.orchestration.map((o) => o.id))).toEqual(
      new Set([dbt, airflow, prefect]),
    );
    expect(r.lane.orchestration.every((o) => o.rule === "name_match")).toBe(true);
    expect(r.lane.prs.map((p) => p.id)).toEqual([byTitle, byBranch]);
    expect(r.lane.prs.every((p) => p.rule === "data:pr_title_or_branch")).toBe(true);
    expect(r.lane.totals).toEqual({ lineage: 2, orchestration: 3, prs: 2 });
    expect(r.gaps.map((g) => g.detail).join(" ")).toContain("DAG-run logs");
  });

  test("an unmatched model gives empty lists, the always-present gaps and no throw", () => {
    const d = db();
    const r = dataLane(d, { metadata: { monitoredDataModelKeys: ["x.y.zzzz"] }, openedAtMs: OPEN });
    expect(r.lane.lineage).toEqual([]);
    expect(r.lane.orchestration).toEqual([]);
    expect(r.lane.prs).toEqual([]);
    expect(r.gaps).toHaveLength(2);
    const none = dataLane(d, { metadata: null, openedAtMs: null });
    expect(none.lane.models).toEqual([]);
    expect(none.gaps).toHaveLength(3);
    expect(dataSubstrateGaps()).toHaveLength(2);
  });

  test("lists are capped at 10 with the true totals", () => {
    const d = db();
    model(
      d,
      MODEL,
      Array.from({ length: 12 }, (_, i) => `up.${String(i).padStart(2, "0")}`),
    );
    for (let i = 0; i < 12; i += 1)
      put(d, "dbt", "job", `1:${String(i)}`, `orders job ${String(i)}`);
    const r = dataLane(d, { metadata: { monitoredDataModelKeys: [MODEL] }, openedAtMs: OPEN });
    expect(r.lane.lineage).toHaveLength(10);
    expect(r.lane.orchestration).toHaveLength(10);
    expect(r.lane.totals).toMatchObject({ lineage: 12, orchestration: 12 });
  });
});
