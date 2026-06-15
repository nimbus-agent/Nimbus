import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { runEmitBenchmarkJsonMain, toBenchmarkPoints } from "./emit-benchmark-json.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-14T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("toBenchmarkPoints", () => {
  test("emits a p95_ms point for a trend latency surface (S1)", () => {
    const points = toBenchmarkPoints(baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } }));
    expect(points).toEqual([{ name: "S1 p95", unit: "ms", value: 812.5 }]);
  });

  test("emits an rss_bytes_p95 point for a trend memory surface (S7-a)", () => {
    const points = toBenchmarkPoints(
      baseLine({ "S7-a": { samples_count: 5, rss_bytes_p95: 134_217_728 } }),
    );
    expect(points).toEqual([{ name: "S7-a rss_p95", unit: "bytes", value: 134_217_728 }]);
  });

  test("does NOT emit gate-class surfaces (S2-a) even with a p95_ms value", () => {
    const points = toBenchmarkPoints(baseLine({ "S2-a": { samples_count: 5, p95_ms: 12.3 } }));
    expect(points).toEqual([]);
  });

  test("does NOT emit reference-class surfaces (S2-c)", () => {
    const points = toBenchmarkPoints(baseLine({ "S2-c": { samples_count: 5, p95_ms: 250 } }));
    expect(points).toEqual([]);
  });

  test("does NOT emit throughput trend surfaces (S6-drive) — deferred this phase", () => {
    const points = toBenchmarkPoints(
      baseLine({ "S6-drive": { samples_count: 5, throughput_per_sec: 42 } }),
    );
    expect(points).toEqual([]);
  });

  test("skips a stub surface (samples_count===0, no metric value)", () => {
    const points = toBenchmarkPoints(baseLine({ S4: { samples_count: 0, stub_reason: "stub" } }));
    expect(points).toEqual([]);
  });

  test("skips a trend surface whose metric value is absent", () => {
    const points = toBenchmarkPoints(baseLine({ S1: { samples_count: 5 } }));
    expect(points).toEqual([]);
  });

  test("emits multiple points in SLO_THRESHOLDS declared order", () => {
    const points = toBenchmarkPoints(
      baseLine({
        "S7-a": { samples_count: 5, rss_bytes_p95: 100 },
        S1: { samples_count: 5, p95_ms: 800 },
        S10: { samples_count: 5, throughput_per_sec: 999 },
      }),
    );
    expect(points).toEqual([
      { name: "S1 p95", unit: "ms", value: 800 },
      { name: "S7-a rss_p95", unit: "bytes", value: 100 },
    ]);
  });

  test("ignores a non-finite metric value", () => {
    const points = toBenchmarkPoints(
      baseLine({ S1: { samples_count: 5, p95_ms: Number.POSITIVE_INFINITY } }),
    );
    expect(points).toEqual([]);
  });
});

describe("runEmitBenchmarkJsonMain", () => {
  test("returns 2 when required flags are missing", async () => {
    expect(await runEmitBenchmarkJsonMain([])).toBe(2);
  });

  test("returns 1 (not an uncaught crash) when the input file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bench-"));
    const code = await runEmitBenchmarkJsonMain([
      "--in",
      join(dir, "does-not-exist.jsonl"),
      "--out",
      join(dir, "out.json"),
    ]);
    expect(code).toBe(1);
  });

  test("writes trend points and returns 0 on a valid input file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bench-"));
    const inPath = join(dir, "run-history.jsonl");
    const outPath = join(dir, "points.json");
    const line: HistoryLine = baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } });
    writeFileSync(inPath, `${JSON.stringify(line)}\n`, "utf8");
    const code = await runEmitBenchmarkJsonMain(["--in", inPath, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual([
      { name: "S1 p95", unit: "ms", value: 812.5 },
    ]);
  });
});
