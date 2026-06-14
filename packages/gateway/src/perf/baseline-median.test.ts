import { describe, expect, test } from "bun:test";

import { medianBaseline, medianOf } from "./baseline-median.ts";
import type { HistoryLine } from "./history-line.ts";

function line(sha: string, surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 1,
    run_id: `run-${sha}`,
    timestamp: "2026-06-14T00:00:00Z",
    runner: "gha-macos",
    os_version: "macos-15",
    nimbus_git_sha: sha,
    bun_version: "1.3.14",
    surfaces,
  };
}

describe("medianOf", () => {
  test("odd-length: returns the middle value", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
  });

  test("even-length: averages the two middle values", () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  test("single element", () => {
    expect(medianOf([42])).toBe(42);
  });

  test("throws on empty input", () => {
    expect(() => medianOf([])).toThrow();
  });
});

describe("medianBaseline", () => {
  test("returns null for no input lines (first-run / all artifacts missing)", () => {
    expect(medianBaseline([])).toBeNull();
  });

  test("per surface, each metric is the median across runs", () => {
    const lines = [
      line("a", { S1: { samples_count: 100, p95_ms: 1200 } }),
      line("b", { S1: { samples_count: 100, p95_ms: 800 } }),
      line("c", { S1: { samples_count: 100, p95_ms: 400 } }),
    ];
    const out = medianBaseline(lines);
    expect(out?.surfaces.S1?.p95_ms).toBe(800);
  });

  test("a single lucky-fast outlier does not drag the baseline down", () => {
    // The bug: a lone fast baseline (S1=400) poisoned the next commit's delta gate.
    // Median over recent runs is robust to that outlier.
    const lines = [
      line("fast", { S1: { samples_count: 100, p95_ms: 400 } }),
      line("typ1", { S1: { samples_count: 100, p95_ms: 820 } }),
      line("typ2", { S1: { samples_count: 100, p95_ms: 780 } }),
      line("typ3", { S1: { samples_count: 100, p95_ms: 800 } }),
      line("typ4", { S1: { samples_count: 100, p95_ms: 810 } }),
    ];
    expect(medianBaseline(lines)?.surfaces.S1?.p95_ms).toBe(800);
  });

  test("aggregates only the runs that report a given surface/metric", () => {
    const lines = [
      line("a", {
        S1: { samples_count: 100, p95_ms: 1000 },
        "S11-a": { samples_count: 50, p95_ms: 300 },
      }),
      line("b", { S1: { samples_count: 100, p95_ms: 800 } }),
    ];
    const out = medianBaseline(lines);
    // S1 present in both → median(1000,800)=900; S11-a present in one → 300
    expect(out?.surfaces.S1?.p95_ms).toBe(900);
    expect(out?.surfaces["S11-a"]?.p95_ms).toBe(300);
  });

  test("skips zero-sample (stub) surface entries", () => {
    const lines = [
      line("a", { S1: { samples_count: 0, p95_ms: 5 } }), // stub — must be ignored
      line("b", { S1: { samples_count: 100, p95_ms: 900 } }),
    ];
    expect(medianBaseline(lines)?.surfaces.S1?.p95_ms).toBe(900);
  });

  test("omits a surface that has no usable (non-stub) samples in any run", () => {
    const lines = [line("a", { S1: { samples_count: 0, p95_ms: 5 } })];
    const out = medianBaseline(lines);
    expect(out).not.toBeNull();
    expect(out?.surfaces.S1).toBeUndefined();
  });

  test("aggregates throughput and rss metrics too", () => {
    const lines = [
      line("a", {
        "S6-drive": { samples_count: 10, throughput_per_sec: 100 },
        "S7-a": { samples_count: 10, rss_bytes_p95: 300 },
      }),
      line("b", {
        "S6-drive": { samples_count: 10, throughput_per_sec: 200 },
        "S7-a": { samples_count: 10, rss_bytes_p95: 500 },
      }),
    ];
    const out = medianBaseline(lines);
    expect(out?.surfaces["S6-drive"]?.throughput_per_sec).toBe(150);
    expect(out?.surfaces["S7-a"]?.rss_bytes_p95).toBe(400);
  });

  test("carries forward the newest run's identifying metadata", () => {
    const lines = [
      line("newest", { S1: { samples_count: 100, p95_ms: 800 } }),
      line("older", { S1: { samples_count: 100, p95_ms: 820 } }),
    ];
    expect(medianBaseline(lines)?.nimbus_git_sha).toBe("newest");
  });
});
