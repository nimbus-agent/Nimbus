import { describe, expect, test } from "bun:test";

import { bindingUpstream, concurrencySeries, median, minutesBetween } from "./probe-lib.ts";

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
  test("picks the upstream job that completed last", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:20:00Z" },
      { name: "c", completed_at: "2026-07-27T10:10:00Z" },
    ];
    expect(bindingUpstream(jobs)?.name).toBe("b");
  });

  test("ignores jobs that never completed", () => {
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "running", completed_at: null },
    ];
    expect(bindingUpstream(jobs)?.name).toBe("a");
  });

  test("an empty list yields null", () => {
    expect(bindingUpstream([])).toBeNull();
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
