import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { writeDbtTest } from "../__fixtures__/dbt-writers.ts";
import { HOUR, resolverFor, serviceConfig, T0 } from "../__fixtures__/index-writers.ts";
import { dataLane, dataSubstrateGaps } from "./data.ts";
import { DBT_KEY_CAP, DBT_WINDOW_AFTER_MS, DBT_WINDOW_BEFORE_MS, dbtTests } from "./data-dbt.ts";

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
const UP = "raw.payments.orders_raw";

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

function lane(d: Database, openedAtMs: number | null = OPEN) {
  return dataLane(d, { metadata: { monitoredDataModelKeys: [MODEL] }, openedAtMs });
}

describe("data lane, dbt tests", () => {
  test("lists failing and warning tests on the monitored model and one hop upstream, worst first", () => {
    const d = db();
    model(d, MODEL, [UP]);
    model(d, UP, []);
    const warn = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.unique_orders_id.aa",
      status: "warn",
      modelKeys: [MODEL],
      finishedAtMs: OPEN - HOUR,
    });
    const fail = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.not_null_orders_id.bb",
      status: "fail",
      modelKeys: [MODEL],
      finishedAtMs: OPEN - 2 * HOUR,
      failures: 12,
    });
    const upstream = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.not_null_raw_id.cc",
      status: "error",
      modelKeys: [UP],
      finishedAtMs: OPEN - HOUR,
    });
    writeDbtTest(d, resolver, {
      uniqueId: "test.shop.other.dd",
      status: "fail",
      modelKeys: ["somewhere.else.table"],
      finishedAtMs: OPEN - HOUR,
    });
    const r = lane(d);
    expect(r.lane.dbtTests?.map((t) => t.id)).toEqual([fail, upstream, warn]);
    expect(r.lane.dbtTests?.map((t) => [t.status, t.via])).toEqual([
      ["fail", "monitored"],
      ["error", "lineage"],
      ["warn", "monitored"],
    ]);
    expect(r.lane.dbtTests?.[0]?.failures).toBe(12);
    expect(r.lane.totals.dbtTests).toBe(3);
    expect(r.lane.dbtTests?.every((t) => t.rule === "data:dbt_test")).toBe(true);
  });

  test("a passing test is never indexed; a result outside the window is not listed", () => {
    const d = db();
    expect(() =>
      writeDbtTest(d, resolver, {
        uniqueId: "test.shop.ok.ee",
        status: "pass",
        modelKeys: [MODEL],
        finishedAtMs: OPEN,
      }),
    ).toThrow("refused");
    writeDbtTest(d, resolver, {
      uniqueId: "test.shop.old.ff",
      status: "fail",
      modelKeys: [MODEL],
      finishedAtMs: OPEN - DBT_WINDOW_BEFORE_MS - 1,
    });
    writeDbtTest(d, resolver, {
      uniqueId: "test.shop.late.gg",
      status: "fail",
      modelKeys: [MODEL],
      finishedAtMs: OPEN + DBT_WINDOW_AFTER_MS + 1,
    });
    const edge = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.edge.hh",
      status: "fail",
      modelKeys: [MODEL],
      finishedAtMs: OPEN - DBT_WINDOW_BEFORE_MS,
    });
    expect(lane(d).lane.dbtTests?.map((t) => t.id)).toEqual([edge]);
  });

  test("a test on a monitored model and an upstream one is listed once, as monitored", () => {
    const d = db();
    model(d, MODEL, [UP]);
    const id = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.rel.ii",
      status: "fail",
      modelKeys: [UP, MODEL],
      finishedAtMs: OPEN - HOUR,
    });
    const tests = lane(d).lane.dbtTests ?? [];
    expect(tests.map((t) => [t.id, t.via, t.model])).toEqual([[id, "monitored", MODEL]]);
  });

  test("a row with an unexpected status or no counts is skipped or listed without them", () => {
    const d = db();
    const raw = (id: string, metadata: Record<string, unknown>): void => {
      upsertIndexedItem(
        d,
        {
          service: "dbt",
          type: "data_quality_test",
          externalId: id,
          title: id,
          bodyPreview: "",
          modifiedAt: OPEN,
          syncedAt: OPEN,
          metadata: { monitoredDataModelKeys: [MODEL], ...metadata },
        },
        resolver,
      );
    };
    raw("odd", { status: "pass" });
    raw("nostatus", {});
    raw("bare", { status: "warn" });
    const tests = lane(d).lane.dbtTests ?? [];
    expect(tests.map((t) => t.id)).toEqual(["dbt:bare"]);
    expect(tests[0]?.failures).toBeNull();
    expect(tests[0]?.runId).toBeNull();
  });

  test("more lineage keys than the cap are cut and the lane is marked truncated", () => {
    const d = db();
    const lin = Array.from({ length: DBT_KEY_CAP + 3 }, (_, i) => ({
      model: MODEL,
      to: `raw.a.m${String(i).padStart(4, "0")}`,
      rule: "data:derived_from" as const,
    }));
    const truncated = { value: false };
    expect(dbtTests(d, [MODEL], lin, OPEN, truncated)).toEqual([]);
    expect(truncated.value).toBe(true);
    expect(dbtTests(d, [], [], OPEN, { value: false })).toEqual([]);
  });

  test("the same test is listed once whichever order its model keys come in", () => {
    const d = db();
    model(d, MODEL, [UP]);
    const lineageFirst = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.a.m1",
      status: "fail",
      modelKeys: [UP, MODEL],
      finishedAtMs: OPEN - HOUR,
    });
    const monitoredFirst = writeDbtTest(d, resolver, {
      uniqueId: "test.shop.b.m2",
      status: "fail",
      modelKeys: [MODEL, UP],
      finishedAtMs: OPEN - HOUR,
    });
    const tests = lane(d).lane.dbtTests ?? [];
    expect(tests.map((t) => [t.id, t.via]).sort()).toEqual(
      [
        [lineageFirst, "monitored"],
        [monitoredFirst, "monitored"],
      ].sort(),
    );
  });

  test("no open time: no dbt query, and the list is empty", () => {
    const d = db();
    writeDbtTest(d, resolver, {
      uniqueId: "test.shop.x.jj",
      status: "fail",
      modelKeys: [MODEL],
      finishedAtMs: OPEN,
    });
    const r = lane(d, null);
    expect(r.lane.dbtTests).toEqual([]);
    expect(r.lane.totals.dbtTests).toBe(0);
  });

  test("the dbt gap: no dbt data at all, or the bounds of what is kept; the substrate gaps no longer name dbt", () => {
    const d = db();
    const none = lane(d).gaps.map((g) => g.detail);
    expect(none.some((g) => g.includes("dbt test results are not indexed (no dbt data)"))).toBe(
      true,
    );
    expect(
      dataSubstrateGaps()
        .map((g) => g.detail)
        .join(" "),
    ).not.toContain("dbt");
    writeDbtTest(d, resolver, {
      uniqueId: "test.shop.y.kk",
      status: "warn",
      modelKeys: ["elsewhere.a.b"],
      finishedAtMs: OPEN,
    });
    const some = lane(d).gaps.map((g) => g.detail);
    expect(some.some((g) => g.includes("never a passing test"))).toBe(true);
    expect(some.some((g) => g.includes("no dbt data"))).toBe(false);
  });
});
