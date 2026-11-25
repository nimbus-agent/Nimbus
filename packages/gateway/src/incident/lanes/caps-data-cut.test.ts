import { describe, expect, test } from "bun:test";

import { buildRecord } from "../__fixtures__/record-builder.ts";
import type {
  DataItemView,
  DataLane,
  DataSchemaChangeView,
  IncidentRecordV1,
} from "../incident-record-types.ts";
import { capRecordSize } from "./caps.ts";

/** `capRecordSize` over the concurrent, prior and data lanes (the schema diff included). */

const LONG = "x".repeat(200);
const bytes = (r: IncidentRecordV1): number => new TextEncoder().encode(JSON.stringify(r)).length;

const item = (i: number, rule: DataItemView["rule"]): DataItemView => ({
  id: `item:${String(i)}`,
  service: "github",
  type: "pr",
  title: LONG,
  url: null,
  atMs: i,
  rule,
});
const change = (i: number): DataSchemaChangeView => ({
  model: `m.${LONG}`,
  via: "monitored",
  atMs: i,
  kind: "added",
  column: `c${String(i)}${LONG}`,
  from: null,
  to: "TEXT",
  rule: "data:schema_history",
});

function dataLane(n: number, withSchema: boolean): DataLane {
  const base: DataLane = {
    models: ["m"],
    lineage: Array.from({ length: n }, (_, i) => ({
      model: `m${LONG}`,
      to: `u${String(i)}${LONG}`,
      rule: "data:derived_from" as const,
    })),
    orchestration: Array.from({ length: n }, (_, i) => item(i, "name_match")),
    prs: Array.from({ length: n }, (_, i) => item(i, "data:pr_title_or_branch")),
    totals: { lineage: n, orchestration: n, prs: n },
  };
  if (!withSchema) return base;
  return {
    ...base,
    schemaDiff: {
      changes: Array.from({ length: n }, (_, i) => change(i)),
      total: n,
      windowFromMs: 0,
      lookbackHours: 24,
    },
  };
}

function withLanes(n: number, data: DataLane | null): IncidentRecordV1 {
  const base = buildRecord();
  return {
    ...base,
    concurrent: {
      skipped: null,
      total: n,
      records: Array.from({ length: n }, (_, i) => ({
        recordId: `inc_${String(i)}${LONG}`,
        triggerItemId: `pagerduty:${String(i)}${LONG}`,
        source: "pagerduty",
        severity: null,
        service: null,
        openedAtMs: i,
        rule: "concurrent_30m" as const,
      })),
    },
    prior: {
      skipped: null,
      total: n,
      incidents: Array.from({ length: n }, (_, i) => ({
        id: `pagerduty:${String(i)}`,
        service: "pagerduty",
        type: "incident",
        title: LONG,
        url: null,
        openedAtMs: i,
        status: "closed" as const,
        closedAtMs: null,
        closedBasis: "none" as const,
        actions: 0,
        rule: "same_service_prior" as const,
      })),
    },
    data,
  };
}

const dataKept = (r: IncidentRecordV1): number =>
  (r.data?.lineage.length ?? 0) +
  (r.data?.orchestration.length ?? 0) +
  (r.data?.prs.length ?? 0) +
  (r.data?.schemaDiff?.changes.length ?? 0);

describe("capRecordSize over the concurrent, prior and data lanes", () => {
  test("cuts concurrent before prior, then shares the data cut across every data list and the schema diff", () => {
    const r = withLanes(100, dataLane(100, true));
    const max = 20_000;
    const out = capRecordSize(r, max);
    const lanes = out.cuts.map((c) => c.lane);
    expect(lanes.indexOf("concurrent")).toBeLessThan(lanes.indexOf("prior"));
    expect(lanes).toContain("data");
    expect(bytes(out.record)).toBeLessThanOrEqual(max);
    const dataCuts = out.cuts.filter((c) => c.lane === "data");
    expect(dataCuts[0]?.before).toBe(400);
    // the first data cut keeps at most half, shared round-robin, so no list (the schema diff included) is
    // favoured over another
    expect(dataKept(out.record)).toBeLessThanOrEqual(200);
    // the true totals are kept beside the cut lists
    expect(out.record.data?.schemaDiff?.total).toBe(100);
    expect(out.record.data?.totals.prs).toBe(100);
  });

  test("a half-cut data lane keeps an equal share of each list", () => {
    const out = capRecordSize(withLanes(0, dataLane(40, true)), 40_000);
    expect(out.cuts.map((c) => c.lane)).toEqual(["data"]);
    expect(out.cuts[0]?.before).toBe(160);
    const d = out.record.data;
    expect([
      d?.lineage.length,
      d?.orchestration.length,
      d?.prs.length,
      d?.schemaDiff?.changes.length,
    ]).toEqual([20, 20, 20, 20]);
    expect(bytes(out.record)).toBeLessThanOrEqual(40_000);
  });

  test("a data lane with no schema diff is cut without inventing one", () => {
    const out = capRecordSize(withLanes(0, dataLane(100, false)), 10_000);
    expect(out.cuts.every((c) => c.lane === "data")).toBe(true);
    expect(out.cuts[0]?.before).toBe(300);
    expect(dataKept(out.record)).toBeLessThan(300);
    expect(out.record.data !== null && "schemaDiff" in out.record.data).toBe(false);
  });

  test("a data lane that is emptied keeps an empty schema diff", () => {
    const out = capRecordSize(withLanes(0, dataLane(50, true)), 1_000);
    expect(out.cuts.at(-1)?.lane).toBe("data");
    expect(dataKept(out.record)).toBe(0);
    expect(out.record.data?.schemaDiff?.changes).toEqual([]);
    expect(out.record.data?.lineage).toEqual([]);
  });
});
