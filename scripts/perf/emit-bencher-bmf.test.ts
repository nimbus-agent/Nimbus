import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { runEmitBencherBmfMain } from "./emit-bencher-bmf.ts";

function baseLine(surfaces: HistoryLine["surfaces"]): HistoryLine {
  return {
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-16T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces,
  };
}

describe("runEmitBencherBmfMain", () => {
  test("returns 2 when required flags are missing", async () => {
    expect(await runEmitBencherBmfMain([])).toBe(2);
  });

  test("returns 1 (not an uncaught crash) when the input file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const code = await runEmitBencherBmfMain([
      "--in",
      join(dir, "missing.jsonl"),
      "--out",
      join(dir, "out.json"),
    ]);
    expect(code).toBe(1);
  });

  test("writes BMF and returns 0 on a valid input file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const inPath = join(dir, "run-history.jsonl");
    const outPath = join(dir, "bencher.json");
    const line: HistoryLine = baseLine({ S1: { samples_count: 5, p95_ms: 812.5 } });
    writeFileSync(inPath, `${JSON.stringify(line)}\n`, "utf8");
    const code = await runEmitBencherBmfMain(["--in", inPath, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({
      S1: { latency: { value: 812.5 } },
    });
  });

  test("writes an empty object for an all-stub line and still returns 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emit-bmf-"));
    const inPath = join(dir, "run-history.jsonl");
    const outPath = join(dir, "bencher.json");
    writeFileSync(inPath, `${JSON.stringify(baseLine({}))}\n`, "utf8");
    const code = await runEmitBencherBmfMain(["--in", inPath, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({});
  });
});
