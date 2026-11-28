import { describe, expect, test } from "bun:test";

import {
  type CostMonthOutcome,
  costMonthsToFetch,
  own,
  requiredCostMonths,
  runCostAccounts,
} from "./cost-month-sync.ts";

const NOV20 = Date.UTC(2026, 10, 20, 9);
const NOV3 = Date.UTC(2026, 10, 3, 9);
const EMPTY = { gaps: {}, synced: {}, pending: {} };

describe("the months a cost sync fetches", () => {
  test("the current month; the previous one until the 5th and on a first sync; pending ones, never future", () => {
    expect(requiredCostMonths(NOV20, false)).toEqual(["2026-11"]);
    expect(requiredCostMonths(NOV3, false)).toEqual(["2026-11", "2026-10"]);
    expect(requiredCostMonths(NOV20, true)).toEqual(["2026-11", "2026-10"]);
    expect(costMonthsToFetch(NOV20, false, ["2026-09", "2026-11", "2027-01"])).toEqual([
      "2026-11",
      "2026-09",
    ]);
  });

  test("own() never reads an inherited property", () => {
    expect(own({}, "constructor")).toBeUndefined();
    expect(own({ constructor: "x" } as Record<string, string>, "constructor")).toBe("x");
  });
});

describe("runCostAccounts", () => {
  const fetcher = (plan: Record<string, CostMonthOutcome>) => {
    const calls: string[] = [];
    const fn = async (account: string, month: string): Promise<CostMonthOutcome> => {
      calls.push(`${account}:${month}`);
      return plan[`${account}:${month}`] ?? { kind: "ok", lines: 1, bytes: 10 };
    };
    return { calls, fn };
  };

  test("all months succeed: lines summed, synced today, nothing pending or gapped", async () => {
    const f = fetcher({});
    const r = await runCostAccounts(EMPTY, ["openai"], NOV20, f.fn);
    expect(f.calls).toEqual(["openai:2026-11", "openai:2026-10"]);
    expect(r).toEqual({
      cursor: { gaps: {}, synced: { openai: "2026-11-20" }, pending: {} },
      lines: 2,
      bytes: 20,
    });
  });

  test("an ok month marked pending is counted and written but stays pending, with no gap", async () => {
    const r = await runCostAccounts(EMPTY, ["aws"], NOV20, async (_a, month) => ({
      kind: "ok",
      lines: 1,
      bytes: 0,
      pending: month === "2026-11",
    }));
    expect(r.cursor).toEqual({
      gaps: {},
      synced: { aws: "2026-11-20" },
      pending: { aws: ["2026-11"] },
    });
    expect(r.lines).toBe(2);
  });

  test("a gap stops that account, keeps the rest pending and leaves it unsynced; others continue", async () => {
    const f = fetcher({ "a:2026-11": { kind: "gap", reason: "no access" } });
    const r = await runCostAccounts(EMPTY, ["a", "b"], NOV20, f.fn);
    expect(f.calls).toEqual(["a:2026-11", "b:2026-11", "b:2026-10"]);
    expect(r.cursor).toEqual({
      gaps: { a: "no access" },
      synced: { b: "2026-11-20" },
      pending: { a: ["2026-11", "2026-10"] },
    });
  });

  test("a retry keeps the earlier gap and the unfinished months; a later success clears both", async () => {
    const prev = { gaps: { a: "old" }, synced: { a: "2026-11-19" }, pending: { a: ["2026-10"] } };
    const flaky = fetcher({ "a:2026-10": { kind: "retry" } });
    const r = await runCostAccounts(prev, ["a"], NOV20, flaky.fn);
    expect(r.cursor).toEqual({
      gaps: { a: "old" },
      synced: { a: "2026-11-20" },
      pending: { a: ["2026-10"] },
    });
    const ok = await runCostAccounts(r.cursor, ["a"], NOV20, fetcher({}).fn);
    expect(ok.cursor).toEqual({ gaps: {}, synced: { a: "2026-11-20" }, pending: {} });
  });

  test("an account no longer passed is dropped, so adding it back is a first sync", async () => {
    const prev = {
      gaps: { gone: "g" },
      synced: { gone: "2026-11-01" },
      pending: { gone: ["2026-09"] },
    };
    const r = await runCostAccounts(prev, [], NOV20, fetcher({}).fn);
    expect(r.cursor).toEqual(EMPTY);
  });

  test("a month gap keeps that month pending with its gap and goes on to older months", async () => {
    const f = fetcher({ "a:2026-11": { kind: "month_gap", reason: "2 rows unreadable" } });
    const r = await runCostAccounts(EMPTY, ["a"], NOV20, f.fn);
    expect(f.calls).toEqual(["a:2026-11", "a:2026-10"]);
    expect(r.cursor).toEqual({
      gaps: { a: "2 rows unreadable" },
      synced: { a: "2026-11-20" },
      pending: { a: ["2026-11"] },
    });
  });
});
