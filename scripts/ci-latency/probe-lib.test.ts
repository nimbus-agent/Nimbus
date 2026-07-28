import { describe, expect, test } from "bun:test";

import {
  accumulateBinding,
  asJobs,
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

  test("an unparseable eligibility timestamp attributes nothing, rather than falling back to the global max", () => {
    // Before this guard, an unparseable eligibleAt parsed to a NaN cutoff, the
    // `at > cutoff` exclusion was always false, and the function fell back to
    // whichever candidate happened to complete last -- the exact
    // misattribution this cutoff exists to prevent, reachable again through
    // bad input.
    const jobs = [
      { name: "a", completed_at: "2026-07-27T10:05:00Z" },
      { name: "b", completed_at: "2026-07-27T10:20:00Z" },
    ];
    expect(bindingUpstream(jobs, "not-a-date")).toBeNull();
  });
});

describe("accumulateBinding", () => {
  const upstream = [
    { name: "ci-rust", completed_at: "2026-07-27T10:05:00Z" },
    { name: "ci-ts", completed_at: "2026-07-27T10:40:00Z" },
  ];

  test("tallies each leg against the job that actually gated it", () => {
    const into = new Map<string, number>();
    const dropped = accumulateBinding(into, upstream, [
      { created_at: "2026-07-27T10:06:00Z" },
      { created_at: "2026-07-27T10:06:00Z" },
      { created_at: "2026-07-27T10:41:00Z" },
    ]);
    expect(dropped).toBe(0);
    expect([...into]).toEqual([
      ["ci-rust", 2],
      ["ci-ts", 1],
    ]);
  });

  test("COUNTS a leg with no eligible upstream instead of dropping it silently", () => {
    // The leg became eligible before any candidate completed. Narrowing E2E to
    // `needs: [ci-rust]` cuts the gating margin from ~60 min to ~1.2 min, so
    // this is now plausible rather than impossible -- and an after-measurement
    // that quietly attributes fewer legs than ran is the one instrument that
    // must not fail toward its own hypothesis.
    const into = new Map<string, number>();
    const dropped = accumulateBinding(into, upstream, [
      { created_at: "2026-07-27T10:00:00Z" },
      { created_at: "2026-07-27T10:06:00Z" },
    ]);
    expect(dropped).toBe(1);
    expect([...into]).toEqual([["ci-rust", 1]]);
  });

  test("with no upstream candidates at all, every leg is reported dropped", () => {
    const into = new Map<string, number>();
    expect(accumulateBinding(into, [], [{ created_at: "2026-07-27T10:06:00Z" }])).toBe(1);
    expect(into.size).toBe(0);
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

  test("a job with a null started_at is excluded from the count, not treated as started at minute 0", () => {
    // A skipped job (e.g. a Linux-only coverage leg skipped on macOS/Windows)
    // reports completed_at but no started_at. If it were kept in without a
    // started_at it would either need to default to time 0 (falsely inflating
    // every early-minute count) or be silently coerced to NaN (which would
    // make it "running" everywhere via a bad comparison). Neither is
    // acceptable -- it must be excluded from this metric entirely.
    const series = concurrencySeries(
      [
        { started_at: "2026-07-27T10:00:00Z", completed_at: "2026-07-27T10:02:00Z" },
        { started_at: null, completed_at: "2026-07-27T10:00:05Z" },
      ],
      "2026-07-27T10:00:00Z",
    );
    expect(series).toEqual([1, 1, 0]);
  });

  test("a job with a null completed_at is excluded from the count", () => {
    const series = concurrencySeries(
      [
        { started_at: "2026-07-27T10:00:00Z", completed_at: "2026-07-27T10:02:00Z" },
        { started_at: "2026-07-27T10:00:00Z", completed_at: null },
      ],
      "2026-07-27T10:00:00Z",
    );
    expect(series).toEqual([1, 1, 0]);
  });

  test("with ONLY null-started jobs, the series is empty rather than throwing", () => {
    expect(
      concurrencySeries(
        [{ started_at: null, completed_at: "2026-07-27T10:00:05Z" }],
        "2026-07-27T10:00:00Z",
      ),
    ).toEqual([]);
  });
});

describe("asJobs", () => {
  test("a job missing started_at is still parsed, with started_at null", () => {
    // This is the read-completeness fix: `pageJobs` judges completeness by
    // comparing the parsed count against the API's total_count. A skipped
    // job still counts toward total_count, so dropping it here for lacking
    // started_at makes that total permanently unreachable.
    const jobs = asJobs({
      jobs: [
        {
          name: "E2E Desktop — windows",
          created_at: "2026-07-27T10:00:00Z",
          started_at: null,
          completed_at: "2026-07-27T10:00:05Z",
        },
      ],
    });
    expect(jobs).toEqual([
      {
        name: "E2E Desktop — windows",
        created_at: "2026-07-27T10:00:00Z",
        started_at: null,
        completed_at: "2026-07-27T10:00:05Z",
      },
    ]);
  });

  test("a job with a non-string started_at is parsed as null rather than dropped", () => {
    const jobs = asJobs({
      jobs: [
        {
          name: "a",
          created_at: "2026-07-27T10:00:00Z",
          started_at: null,
          completed_at: null,
        },
      ],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.started_at).toBeNull();
  });

  test("a job missing name or created_at is still dropped", () => {
    const jobs = asJobs({
      jobs: [
        { created_at: "2026-07-27T10:00:00Z", started_at: null, completed_at: null },
        { name: "a", started_at: null, completed_at: null },
      ],
    });
    expect(jobs).toEqual([]);
  });

  test("read-completeness: a page of jobs missing started_at still reconciles against total_count", () => {
    // The interaction this whole fix targets: `pageJobs` compares the parsed
    // job count against total_count. Before this fix, `asJobs` dropped any
    // record lacking started_at, so a run with a skipped job could never
    // reach total_count and was misjudged incomplete -- excluded wholesale
    // from every downstream figure.
    const payload = {
      total_count: 2,
      jobs: [
        {
          name: "ci-ts",
          created_at: "2026-07-27T10:00:00Z",
          started_at: "2026-07-27T10:00:01Z",
          completed_at: "2026-07-27T10:05:00Z",
        },
        {
          name: "E2E Desktop — windows (Coverage: Engine)",
          created_at: "2026-07-27T10:00:00Z",
          started_at: null,
          completed_at: "2026-07-27T10:00:00Z",
        },
      ],
    };
    const result = pageJobs((page) => (page === 1 ? payload : null), asJobs);
    expect(result.complete).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[1]?.started_at).toBeNull();
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
