import { describe, expect, test } from "bun:test";

import { buildDataLane } from "../__fixtures__/data-brief.ts";
import { buildRecord } from "../__fixtures__/record-builder.ts";
import type { IncidentRecordV1 } from "../incident-record-types.ts";
import { allocate, capRecordSize, gap, oneLine } from "./caps.ts";

function fat(n: number): IncidentRecordV1 {
  const base = buildRecord();
  const msg = (i: number) => ({
    id: `slack:${String(i)}`,
    service: "slack",
    title: "t".repeat(200),
    url: null,
    atMs: i,
    rule: "chat_phrase:x",
  });
  const hist = (i: number) => ({
    key: "status",
    from: "a".repeat(200),
    to: "b".repeat(200),
    observedAtMs: i,
    sourceAtMs: null,
  });
  return {
    ...base,
    chat: { ...base.chat, total: n, messages: Array.from({ length: n }, (_, i) => msg(i)) },
    history: {
      startsMs: 1,
      total: n,
      truncated: 0,
      rows: Array.from({ length: n }, (_, i) => hist(i)),
    },
  };
}

describe("oneLine", () => {
  test("removes format characters, collapses controls and caps by code points", () => {
    expect(oneLine("a\u{202E}b\u{200B}c\nd\te")).toBe("abc d e");
    const long = oneLine("😀".repeat(300));
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(oneLine("  x  ")).toBe("x");
  });
});

describe("capRecordSize", () => {
  test("a record that fits is returned as is", () => {
    const r = buildRecord();
    expect(capRecordSize(r)).toEqual({ record: r, cuts: [] });
  });

  test("cuts in the fixed order chat, concurrent, prior, history, data, and says what it cut", () => {
    const r = fat(400);
    const out = capRecordSize(r, 30_000);
    expect(out.cuts.length).toBeGreaterThan(0);
    expect(out.cuts[0]?.lane).toBe("chat");
    expect(new TextEncoder().encode(JSON.stringify(out.record)).length).toBeLessThanOrEqual(30_000);
    // chat is cut before history is touched
    const lanes = out.cuts.map((c) => c.lane);
    expect(lanes.indexOf("chat")).toBeLessThan(
      lanes.includes("history") ? lanes.indexOf("history") : 99,
    );
    expect(out.record.chat.total).toBe(400); // the true total is kept
  });

  test("history cuts keep the truncated count honest", () => {
    const r = fat(300);
    const out = capRecordSize(r, 8_000);
    expect(out.record.history.truncated).toBe(
      out.record.history.total - out.record.history.rows.length,
    );
    expect(out.cuts.some((c) => c.lane === "history")).toBe(true);
  });
});

describe("gap", () => {
  test("omits an absent remediation", () => {
    expect(gap("missing_connector", "d")).toEqual({ category: "missing_connector", detail: "d" });
    expect(gap("missing_connector", "d", "r").remediation).toBe("r");
  });
});

describe("allocate and the data cut", () => {
  test("shares the retained entries round-robin over the lists that still have some", () => {
    expect(allocate(5, [10, 0, 0])).toEqual([5, 0, 0]);
    expect(allocate(5, [1, 10, 10])).toEqual([1, 2, 2]);
    expect(allocate(100, [2, 1, 0])).toEqual([2, 1, 0]);
    expect(allocate(0, [3, 3])).toEqual([0, 0]);
  });
});

describe("the data cut with dbt tests", () => {
  const test0 = buildDataLane().dbtTests?.[0];
  if (test0 === undefined) throw new Error("fixture: the data lane has no dbt test");
  const fatTest = (i: number) => ({ ...test0, id: `dbt:${String(i)}`, title: "t".repeat(200) });

  test("dbt tests are cut with the rest of the data lane, and the true total stays", () => {
    const data = buildDataLane({
      dbtTests: Array.from({ length: 300 }, (_, i) => fatTest(i)),
      totals: { lineage: 1, orchestration: 1, prs: 1, dbtTests: 300 },
    });
    const out = capRecordSize({ ...buildRecord(), data }, 20_000);
    const dataCuts = out.cuts.filter((c) => c.lane === "data");
    expect(dataCuts.length).toBeGreaterThan(0);
    // each cut is measured on the lane as the previous cut left it
    expect(dataCuts.every((c) => c.after < c.before)).toBe(true);
    expect(dataCuts[0]?.before).toBe(303);
    expect((out.record.data?.dbtTests ?? []).length).toBeLessThan(300);
    expect(out.record.data?.totals.dbtTests).toBe(300);
  });

  test("a data lane stored before dbt tests existed is cut without gaining the field", () => {
    const { dbtTests: _drop, ...old } = buildDataLane();
    const data = {
      ...old,
      lineage: Array.from({ length: 300 }, (_, i) => ({
        model: "m",
        to: `raw.${String(i)}${"x".repeat(200)}`,
        rule: "data:derived_from" as const,
      })),
    };
    const out = capRecordSize({ ...buildRecord(), data }, 20_000);
    expect(out.cuts.some((c) => c.lane === "data")).toBe(true);
    expect(out.record.data !== null && "dbtTests" in out.record.data).toBe(false);
  });
});

describe("the data cut counts every list, as the previous cut left it", () => {
  const test0 = buildDataLane().dbtTests?.[0];
  if (test0 === undefined) throw new Error("fixture: the data lane has no dbt test");
  const long = "t".repeat(200);

  test("dbt tests and schema changes are in the cut, and each step's before is the last step's after", () => {
    const n = 120;
    const data = buildDataLane({
      dbtTests: Array.from({ length: n }, (_, i) => ({
        ...test0,
        id: `dbt:${String(i)}`,
        title: long,
      })),
      schemaDiff: {
        changes: Array.from({ length: n }, (_, i) => ({
          model: "m",
          via: "monitored" as const,
          atMs: i,
          kind: "added" as const,
          column: `c${String(i)}${long}`,
          from: null,
          to: "TEXT",
          rule: "data:schema_history" as const,
        })),
        total: n,
        windowFromMs: 0,
        lookbackHours: 24,
      },
      totals: { lineage: 1, orchestration: 1, prs: 1, dbtTests: n },
    });
    const out = capRecordSize({ ...buildRecord(), data }, 40_000);
    const steps = out.cuts.filter((c) => c.lane === "data");
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]?.before).toBe(3 + 2 * n);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]?.before).toBe(steps[i - 1]?.after);
    }
    const kept = out.record.data;
    const left =
      (kept?.lineage.length ?? 0) +
      (kept?.orchestration.length ?? 0) +
      (kept?.prs.length ?? 0) +
      (kept?.dbtTests?.length ?? 0) +
      (kept?.schemaDiff?.changes.length ?? 0);
    expect(steps.at(-1)?.after).toBe(left);
    expect(kept?.schemaDiff?.changes.length ?? n).toBeLessThan(n);
    expect(kept?.dbtTests?.length ?? n).toBeLessThan(n);
  });
});
