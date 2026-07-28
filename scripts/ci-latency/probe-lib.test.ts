import { describe, expect, test } from "bun:test";

import {
  bindingUpstream,
  concurrencySeries,
  median,
  minutesBetween,
  pageJobs,
} from "./probe-lib.ts";

describe("median", () => {
  test("odd-length picks the middle", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even-length averages the two middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("an empty sample is 0, not NaN", () => {
    // A NaN would propagate silently into every printed figure.
    expect(median([])).toBe(0);
  });
});

describe("minutesBetween", () => {
  test("returns whole minutes between two ISO timestamps", () => {
    expect(minutesBetween("2026-07-27T10:30:00Z", "2026-07-27T10:00:00Z")).toBe(30);
  });

  test("an unparseable timestamp yields 0 rather than NaN", () => {
    expect(minutesBetween("not-a-date", "2026-07-27T10:00:00Z")).toBe(0);
  });
});

describe("bindingUpstream", () => {
  test("picks the upstream job that completed last, at or before eligibility", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:20:00Z" },
      { name: "c", completed_at: "2026-07-27T10:10:00Z" },
    ];
    expect(bindingUpstream(jobs, "2026-07-27T10:25:00Z")?.name).toBe("b");
  });

  test("ignores jobs that never completed", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "running", completed_at: null },
    ];
    expect(bindingUpstream(jobs, "2026-07-27T10:30:00Z")?.name).toBe("a");
  });

  test("excludes a candidate that completed AFTER the eligibility moment", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:20:00Z" },
    ];
    // b finished after the leg became eligible -- it cannot have gated it,
    // even though it is the global-latest completion.
    expect(bindingUpstream(jobs, "2026-07-27T10:10:00Z")?.name).toBe("a");
  });

  test("picks the latest candidate at or before the eligibility moment, not the global latest", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:10:00Z" },
      { name: "c", completed_at: "2026-07-27T10:20:00Z" },
    ];
    expect(bindingUpstream(jobs, "2026-07-27T10:10:00Z")?.name).toBe("b");
  });

  test("an empty candidate list yields null", () => {
    expect(bindingUpstream([], "2026-07-27T10:00:00Z")).toBeNull();
  });
});

describe("concurrencySeries", () => {
  test("counts jobs running at each minute offset", () => {
    // Two jobs overlap only at minute 1.
    const series = concurrencySeries(
      [
        { started_at: "2026-07-27T10:00:00Z", completed_at: "2026-07-27T10:02:00Z" },
        { started_at: "2026-07-27T10:01:00Z", completed_at: "2026-07-27T10:03:00Z" },
      ],
      "2026-07-27T10:00:00Z",
    );
    expect(series).toEqual([1, 2, 1, 0]);
  });

  test("no jobs yields an empty series", () => {
    expect(concurrencySeries([], "2026-07-27T10:00:00Z")).toEqual([]);
  });
});

interface FakeJob {
  id: number;
}

function parseFakeBatch(payload: unknown): FakeJob[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { jobs?: unknown }).jobs)
  ) {
    return [];
  }
  return (payload as { jobs: FakeJob[] }).jobs;
}

describe("pageJobs", () => {
  test("a failed page read yields complete: false, not a false end-of-pagination", () => {
    // Page 1 declares 3 jobs total but only delivers 1; page 2 fails outright
    // (returns null). A read that mistook the null for "no more pages" would
    // report complete: true with a truncated job list -- exactly the failure
    // mode that would make an AFTER run look like a win.
    const result = pageJobs(
      (page) => (page === 1 ? { total_count: 3, jobs: [{ id: 1 }] } : null),
      parseFakeBatch,
    );
    expect(result.complete).toBe(false);
    expect(result.jobs).toEqual([{ id: 1 }]);
    expect(result.expected).toBe(3);
  });

  test("reconciles against total_count across multiple successful pages", () => {
    const pages: Record<number, unknown> = {
      1: { total_count: 2, jobs: [{ id: 1 }] },
      2: { total_count: 2, jobs: [{ id: 2 }] },
    };
    const result = pageJobs((page) => pages[page] ?? null, parseFakeBatch);
    expect(result.complete).toBe(true);
    expect(result.jobs).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.expected).toBe(2);
  });

  test("an empty page ends pagination -- distinct from a failed read", () => {
    // No total_count ever arrives, so `expected` stays undefined and the read
    // is correctly reported incomplete rather than crashing on a missing count.
    const result = pageJobs((page) => (page === 1 ? { jobs: [] } : null), parseFakeBatch);
    expect(result.complete).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.expected).toBeUndefined();
  });
});
