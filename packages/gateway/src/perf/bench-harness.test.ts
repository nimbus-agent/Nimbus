import { describe, expect, test } from "bun:test";
import { runBench } from "./bench-harness.ts";

describe("runBench", () => {
  test("invokes the surface fn `runs` times and returns median-of-medians", async () => {
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
    expect(result.p95Ms).toBeGreaterThan(95);
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
