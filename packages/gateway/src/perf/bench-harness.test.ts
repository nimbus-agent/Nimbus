import { describe, expect, test } from "bun:test";
import { poolTrimmedSamples, runBench } from "./bench-harness.ts";

describe("runBench", () => {
  test("invokes the surface fn `runs` times and returns a pooled p95", async () => {
    let calls = 0;
    const fn = async (): Promise<number[]> => {
      calls += 1;
      return Array.from({ length: 100 }, (_, i) => i + calls);
    };
    const result = await runBench("S2-a", fn, {
      runs: 5,
      runner: "local-dev",
      corpus: "small",
    });
    expect(calls).toBe(5);
    expect(result.surfaceId).toBe("S2-a");
    expect(result.samplesCount).toBe(500);
    // Worst run (calls=5, values 5..104) is trimmed; pool is runs 1..4 (values 1..103).
    expect(result.p95Ms).toBeGreaterThan(90);
    expect(result.p95Ms).toBeLessThan(105);
  });

  test("propagates surface errors with surface id context", async () => {
    const fn = async (): Promise<number[]> => {
      throw new Error("synthetic failure");
    };
    await expect(runBench("S1", fn, { runs: 1, runner: "local-dev" })).rejects.toThrow(
      /S1.*synthetic failure/,
    );
  });

  test("emits per-run failure context to stderr before throwing", async () => {
    const fn = async (): Promise<number[]> => {
      throw new Error("inner failure detail");
    };
    const stderrLines: string[] = [];
    await expect(
      runBench(
        "S2-a",
        fn,
        { runs: 3, runner: "local-dev" },
        {
          stderr: (s) => stderrLines.push(s),
        },
      ),
    ).rejects.toThrow();
    expect(stderrLines.length).toBeGreaterThanOrEqual(1);
    expect(stderrLines[0]).toMatch(/\[bench:S2-a\] run 1\/3 failed: inner failure detail/);
  });

  test("rejects runs < 1 with a clear error", async () => {
    const fn = async (): Promise<number[]> => [1];
    await expect(runBench("S1", fn, { runs: 0, runner: "local-dev" })).rejects.toThrow(
      /runs must be >= 1/,
    );
  });
});

describe("runBench — resultKind", () => {
  test("default 'latency' behaviour is unchanged", async () => {
    const fn = async (): Promise<number[]> => [10, 20, 30, 40, 50];
    const result = await runBench("S2-a", fn, { runs: 3, runner: "local-dev" });
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.throughputPerSec).toBeUndefined();
    expect(result.rssBytesP95).toBeUndefined();
  });

  test("'throughput' kind populates throughputPerSec from per-run medians", async () => {
    const fn = async (): Promise<number[]> => [100, 110, 120];
    const result = await runBench("S2-a", fn, { runs: 3, runner: "local-dev" }, {}, "throughput");
    expect(result.throughputPerSec).toBe(110);
    expect(result.p50Ms).toBeUndefined();
    expect(result.p95Ms).toBeUndefined();
  });

  test("'rss' kind populates rssBytesP95 across all samples", async () => {
    const fn = async (): Promise<number[]> => [
      1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000,
    ];
    const result = await runBench("S7-a", fn, { runs: 1, runner: "local-dev" }, {}, "rss");
    expect(result.rssBytesP95).toBeGreaterThanOrEqual(1_300_000);
    expect(result.rssBytesP95).toBeLessThanOrEqual(1_400_000);
    expect(result.rawSamples).toEqual([1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000]);
    expect(result.p50Ms).toBeUndefined();
  });
});

describe("runBench — busyRetries side-channel (S10)", () => {
  test("BenchSurfaceResult preserves a busyRetries field that callers attach post-hoc", async () => {
    const fn = async (): Promise<number[]> => [100, 200, 300];
    const result = await runBench("S10", fn, { runs: 1, runner: "local-dev" }, {}, "throughput");
    expect(result.busyRetries).toBeUndefined();
    const withRetries: typeof result = { ...result, busyRetries: 42 };
    expect(withRetries.busyRetries).toBe(42);
    expect(withRetries.surfaceId).toBe("S10");
    expect(withRetries.throughputPerSec).toBe(200);
  });
});

describe("poolTrimmedSamples", () => {
  test("with fewer than 3 non-empty runs, returns all samples flattened (no trim)", () => {
    expect(
      poolTrimmedSamples([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([1, 2, 3, 4]);
    expect(poolTrimmedSamples([[1, 2]])).toEqual([1, 2]);
  });

  test("filters out empty runs before counting toward the trim threshold", () => {
    // 2 non-empty runs + an empty one → still < 3 non-empty → no trim, empties dropped.
    expect(poolTrimmedSamples([[1, 2], [], [3, 4]])).toEqual([1, 2, 3, 4]);
  });

  test("with >=3 non-empty runs, drops the single worst run (highest per-run p95)", () => {
    // Run C's p95 (~1000) is the highest; it is dropped, leaving A+B pooled.
    const a = [1, 2, 3, 4, 5];
    const b = [2, 3, 4, 5, 6];
    const c = [900, 950, 1000, 1000, 1000];
    const pooled = poolTrimmedSamples([a, b, c]);
    expect(pooled.sort((x, y) => x - y)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(pooled).not.toContain(1000);
  });

  test("a single catastrophically-contended run does not enter the pooled p95", () => {
    // 4 calm runs + 1 disk-thrash run; the thrash run is trimmed → stable aggregate.
    const calm = Array.from({ length: 100 }, () => 10); // all 10ms
    const runs = [calm, calm, calm, calm, Array(100).fill(100_000)];
    const pooled = poolTrimmedSamples(runs);
    expect(pooled).not.toContain(100_000);
    expect(pooled).toHaveLength(400);
  });

  test("returns empty array when passed an empty array", () => {
    expect(poolTrimmedSamples([])).toEqual([]);
  });

  test("returns empty array when passed only empty arrays", () => {
    expect(poolTrimmedSamples([[], [], []])).toEqual([]);
  });
});
