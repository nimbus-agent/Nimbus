/**
 * `runBench` paths `bench-harness.test.ts` does not reach: the even-count median, runs that return
 * no samples on the throughput path, and failure reporting for a non-Error throw and for an Error
 * that carries no stack.
 */
import { describe, expect, test } from "bun:test";
import { runBench } from "./bench-harness.ts";

function sequence(perRun: number[][]): () => Promise<number[]> {
  let i = 0;
  return async () => {
    const run = perRun[i] ?? [];
    i += 1;
    return run;
  };
}

describe("runBench — throughput medians", () => {
  test("an even sample count takes the mean of the two middle values, per run and across runs", async () => {
    const result = await runBench(
      "S6-drive",
      sequence([
        [130, 100, 120, 110], // sorted 100,110,120,130 → (110 + 120) / 2 = 115
        [40, 10], // → 25
      ]),
      { runs: 2, runner: "local-dev" },
      {},
      "throughput",
    );
    // Median of the per-run medians [115, 25] is again an even-count median: (25 + 115) / 2.
    expect(result.throughputPerSec).toBe(70);
    expect(result.samplesCount).toBe(6);
  });

  test("a run that returns no samples contributes no median", async () => {
    const result = await runBench(
      "S10",
      sequence([[], [5], [9]]),
      { runs: 3, runner: "local-dev" },
      {},
      "throughput",
    );
    expect(result.throughputPerSec).toBe(7);
    expect(result.samplesCount).toBe(2);
  });

  test("when every run is empty there is no throughput figure at all, not a zero", async () => {
    const result = await runBench(
      "S10",
      sequence([[], []]),
      { runs: 2, runner: "local-dev" },
      {},
      "throughput",
    );
    expect(result).toEqual({ surfaceId: "S10", samplesCount: 0 });
    expect("throughputPerSec" in result).toBe(false);
  });
});

describe("runBench — failure reporting", () => {
  test("a non-Error throw is reported in its string form, with no stack suffix", async () => {
    const lines: string[] = [];
    let calls = 0;
    await expect(
      runBench(
        "S1",
        async () => {
          calls += 1;
          throw 503;
        },
        { runs: 2, runner: "local-dev" },
        { stderr: (s) => lines.push(s) },
      ),
    ).rejects.toThrow("bench surface S1 failed on run 1/2: 503");
    expect(lines).toEqual(["[bench:S1] run 1/2 failed: 503"]);
    // The first failure ends the bench: run 2 never starts.
    expect(calls).toBe(1);
  });

  test("an Error with an empty stack is reported without a trailing stack block", async () => {
    const lines: string[] = [];
    const bare = new Error("disk full");
    bare.stack = "";
    await expect(
      runBench(
        "S2-a",
        async () => {
          throw bare;
        },
        { runs: 1, runner: "local-dev" },
        { stderr: (s) => lines.push(s) },
      ),
    ).rejects.toThrow("bench surface S2-a failed on run 1/1: disk full");
    expect(lines).toEqual(["[bench:S2-a] run 1/1 failed: disk full"]);
  });

  test("an Error with a stack appends it on the following lines", async () => {
    const lines: string[] = [];
    const withStack = new Error("timeout");
    withStack.stack = "Error: timeout\n    at driver (bench.ts:1:1)";
    await expect(
      runBench(
        "S2-a",
        async () => {
          throw withStack;
        },
        { runs: 1, runner: "local-dev" },
        { stderr: (s) => lines.push(s) },
      ),
    ).rejects.toThrow("bench surface S2-a failed on run 1/1: timeout");
    expect(lines).toEqual([
      "[bench:S2-a] run 1/1 failed: timeout\nError: timeout\n    at driver (bench.ts:1:1)",
    ]);
  });
});
