import { describe, expect, test } from "bun:test";
import { buildDataLane } from "../__fixtures__/data-brief.ts";
import { buildRecord } from "../__fixtures__/record-builder.ts";
import type { DataLane, DataRunView, IncidentRecordV1 } from "../incident-record-types.ts";
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

describe("the data cut and runs", () => {
  const run = (i: number): DataRunView => ({
    id: `airflow:d|r${String(i)}`,
    service: "airflow",
    type: "dag_run",
    job: "j".repeat(200),
    state: "failed",
    outcome: "failed",
    startMs: i,
    endMs: i + 1,
    failedTasks: ["t".repeat(120), "u".repeat(120)],
    failedTaskCount: 2,
    trigger: "scheduled",
    url: null,
    rule: "data:run_of_matched_job",
  });
  const bytes = (r: IncidentRecordV1) => new TextEncoder().encode(JSON.stringify(r)).length;
  const withData = (data: DataLane): IncidentRecordV1 => ({ ...buildRecord(), data });

  test("a cut trims the runs with the other data lists and keeps the true total", () => {
    const lane = buildDataLane({
      runs: Array.from({ length: 10 }, (_, i) => run(i)),
      totals: { lineage: 1, orchestration: 1, prs: 1, runs: 40 },
    });
    const rec = withData(lane);
    const limit = bytes(withData({ ...lane, runs: [] })) + 300;
    const out = capRecordSize(rec, limit);
    expect(out.cuts.some((c) => c.lane === "data")).toBe(true);
    expect((out.record.data?.runs ?? []).length).toBeLessThan(10);
    expect(out.record.data?.totals.runs).toBe(40);
  });

  test("a record stored before runs existed is cut without gaining a runs list", () => {
    const { runs: _runs, ...old } = buildDataLane();
    const fatItems = Array.from({ length: 10 }, (_, i) => ({
      id: `dbt:job${String(i)}`,
      service: "dbt",
      type: "job",
      title: "t".repeat(200),
      url: null,
      atMs: null,
      rule: "name_match" as const,
    }));
    const lane: DataLane = { ...old, orchestration: fatItems };
    const out = capRecordSize(
      withData(lane),
      bytes(withData({ ...lane, orchestration: [] })) + 300,
    );
    expect(out.record.data?.orchestration.length).toBeLessThan(10);
    expect(out.record.data?.runs).toBeUndefined();
  });
});
