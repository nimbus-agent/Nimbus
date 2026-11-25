import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { HOUR, resolverFor, serviceConfig, T0 } from "../__fixtures__/index-writers.ts";
import { dataLane, dataSubstrateGaps } from "./data.ts";
import { AFTER_OPEN_MS, SCHEMA_CHANGE_CAP, schemaLane } from "./data-schema.ts";

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
const OPEN = T0 + 48 * HOUR;
const MODEL = "analytics.payments.orders";
const UP = "raw.payments.orders_raw";
const col = (name: string, type = "NUMBER", nullable = true) => ({ name, type, nullable });

function snow(
  d: Database,
  key: string,
  at: number,
  columns: unknown[],
  complete = true,
  derivedFrom: string[] = [],
): void {
  upsertIndexedItem(
    d,
    {
      service: "snowflake",
      type: "data_model",
      externalId: `snowflake:${key}`,
      title: key,
      bodyPreview: "",
      modifiedAt: at,
      syncedAt: at,
      metadata: {
        dataModelKey: key,
        columns,
        columnsComplete: complete,
        derivedFromKeys: derivedFrom,
      },
    },
    resolver,
  );
}

describe("the data lane's schema changes", () => {
  test("a monitored table and its one-hop upstream list their changes inside the window", () => {
    const d = db();
    snow(d, MODEL, T0, [col("id"), col("amount")], true, [UP]);
    snow(d, UP, T0, [col("raw_id")]);
    snow(d, MODEL, OPEN - 2 * HOUR, [col("id"), col("amount", "TEXT")], true, [UP]);
    snow(d, UP, OPEN - HOUR, [col("raw_id"), col("raw_new", "DATE", false)]);
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN + HOUR,
      schemaLookbackHours: 24,
    });
    const s = r.lane.schemaDiff;
    expect(s?.total).toBe(2);
    expect(
      s?.changes.map((c) => `${c.via}:${c.model}:${c.kind}:${c.column}:${c.from}>${c.to}`),
    ).toEqual([
      "upstream:raw.payments.orders_raw:added:raw_new:null>DATE",
      "monitored:analytics.payments.orders:type_changed:amount:NUMBER>TEXT",
    ]);
    expect(s?.windowFromMs).toBe(OPEN - 24 * HOUR);
    expect(s?.changes.every((c) => c.rule === "data:schema_history")).toBe(true);
    // both tables have history, and nothing is incomplete: no schema gap, and the old phrase is gone
    expect(r.gaps.map((g) => g.detail).join("\n")).not.toContain("schema");
    expect(
      dataSubstrateGaps()
        .map((g) => g.detail)
        .join("\n"),
    ).not.toContain("schema");
  });

  test("a change before the lookback, or after assembly, is not listed", () => {
    const d = db();
    snow(d, MODEL, T0, [col("id")]);
    snow(d, MODEL, OPEN - 30 * HOUR, [col("id"), col("old")]);
    snow(d, MODEL, OPEN + 5 * HOUR, [col("id"), col("old"), col("future")]);
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN + HOUR,
      schemaLookbackHours: 24,
    });
    expect(r.lane.schemaDiff?.total).toBe(0);
    const wide = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN + 6 * HOUR,
      schemaLookbackHours: 48,
    });
    expect(wide.lane.schemaDiff?.changes.map((c) => c.column)).toEqual(["future", "old"]);
  });

  test("the window never extends past 24 hours after the open time", () => {
    const d = db();
    snow(d, MODEL, T0, [col("id")]);
    snow(d, MODEL, OPEN + AFTER_OPEN_MS + HOUR, [col("id"), col("late")]);
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN + 100 * HOUR,
    });
    expect(r.lane.schemaDiff?.total).toBe(0);
  });

  test("a table with no history reports a gap that names it and the Redshift bound", () => {
    const d = db();
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN,
    });
    const gap = r.gaps.find((g) => g.detail.includes("No schema history"));
    expect(gap?.detail).toContain(MODEL);
    expect(gap?.detail).toContain("Redshift has no connector");
    expect(r.lane.schemaDiff?.total).toBe(0);
  });

  test("an incomplete observation is a gap and its columns are never reported dropped", () => {
    const d = db();
    snow(d, MODEL, T0, [col("id"), col("amount")]);
    snow(d, MODEL, OPEN - 2 * HOUR, [col("id")], false);
    snow(d, MODEL, OPEN - HOUR, [col("id")]);
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN,
    });
    expect(r.lane.schemaDiff?.changes).toEqual([]);
    expect(r.gaps.some((g) => g.detail.includes("no column is reported dropped"))).toBe(true);
  });

  test("no monitored table adds no schema gap; no open time says so; the changes are capped", () => {
    const d = db();
    expect(
      schemaLane(d, { models: [], lineage: [], openedAtMs: OPEN, nowMs: null, lookbackHours: 24 }),
    ).toEqual({ lane: null, gaps: [] });
    const noOpen = schemaLane(d, {
      models: [MODEL],
      lineage: [],
      openedAtMs: null,
      nowMs: null,
      lookbackHours: 24,
    });
    expect(noOpen.lane).toBeNull();
    expect(noOpen.gaps[0]?.detail).toContain("no open time");

    snow(d, MODEL, T0, [col("c0")]);
    snow(
      d,
      MODEL,
      OPEN - HOUR,
      Array.from({ length: SCHEMA_CHANGE_CAP + 10 }, (_, i) => col(`c${String(i)}`)),
    );
    const big = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN,
    });
    expect(big.lane.schemaDiff?.changes).toHaveLength(SCHEMA_CHANGE_CAP);
    expect(big.lane.schemaDiff?.total).toBe(SCHEMA_CHANGE_CAP + 9);
  });

  test("column text is one line and capped", () => {
    const d = db();
    snow(d, MODEL, T0, [col("id")]);
    snow(d, MODEL, OPEN - HOUR, [col("id"), col(`evil\ncol${"x".repeat(300)}`)]);
    const r = dataLane(d, {
      metadata: { monitoredDataModelKeys: [MODEL] },
      openedAtMs: OPEN,
      nowMs: OPEN,
    });
    const c = r.lane.schemaDiff?.changes[0]?.column ?? "";
    expect(c).not.toContain("\n");
    expect(Array.from(c).length).toBeLessThanOrEqual(128);
  });
});
