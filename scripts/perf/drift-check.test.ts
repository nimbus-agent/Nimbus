import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectDrift, isRunnerKind, parseHistoryLines } from "./drift-check.ts";

describe("detectDrift", () => {
  test("returns false when there is not enough history to fill the window", () => {
    expect(detectDrift([{ value: 100 }, { value: 100 }], 10)).toBe(false);
  });

  test("a single late spike does NOT trip drift (needs n consecutive worse samples)", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a sustained regression (n consecutive samples worse than the rolling median) trips drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("worse-but-within-the-noise-floor does not trip drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 105 },
      { value: 105 },
      { value: 105 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a worse sample that breaks the consecutive run resets the counter", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("the rolling median is over the last k samples, not the whole history", () => {
    const history = [
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("honors a custom k and n", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 150 },
      { value: 150 },
    ];
    expect(detectDrift(history, 10, 3, 2)).toBe(true);
  });
});

describe("parseHistoryLines", () => {
  function writeLines(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "drift-parse-"));
    const path = join(dir, "run-history.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  const v2Line = JSON.stringify({
    schema_version: 2,
    run_id: "run-1",
    timestamp: "2026-06-14T00:00:00.000Z",
    runner: "gha-ubuntu",
    os_version: "linux x64",
    nimbus_git_sha: "abc123",
    bun_version: "1.2.0",
    surfaces: { S1: { samples_count: 5, p95_ms: 800 } },
  });

  test("returns [] when the file is unreadable", () => {
    expect(parseHistoryLines(join(tmpdir(), "definitely-missing-drift.jsonl"))).toEqual([]);
  });

  test("keeps well-formed schema_version 2 lines", () => {
    const lines = parseHistoryLines(writeLines([v2Line]));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.surfaces.S1?.p95_ms).toBe(800);
  });

  test("skips schema_version 1 lines (non-comparable semantics)", () => {
    const v1Line = JSON.stringify({ schema_version: 1, runner: "gha-ubuntu", surfaces: {} });
    expect(parseHistoryLines(writeLines([v1Line, v2Line]))).toHaveLength(1);
  });

  test("skips malformed JSON and objects missing surfaces", () => {
    const noSurfaces = JSON.stringify({ schema_version: 2, runner: "gha-ubuntu" });
    expect(parseHistoryLines(writeLines(["{not json", noSurfaces, v2Line]))).toHaveLength(1);
  });
});

describe("isRunnerKind", () => {
  test("accepts every declared RunnerKind", () => {
    for (const r of ["reference-m1air", "gha-ubuntu", "gha-macos", "gha-windows", "local-dev"]) {
      expect(isRunnerKind(r)).toBe(true);
    }
  });

  test("rejects an unknown runner value", () => {
    expect(isRunnerKind("m1-air")).toBe(false);
    expect(isRunnerKind("")).toBe(false);
  });
});
