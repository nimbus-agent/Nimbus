import { describe, expect, test } from "bun:test";

import type { HistoryLine } from "../../packages/gateway/src/perf/history-line.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

function v2(p95: number): string {
  const line: HistoryLine = {
    schema_version: 2,
    run_id: "r",
    timestamp: "2026-06-16T00:00:00Z",
    runner: "gha-ubuntu",
    os_version: "ubuntu-24.04",
    nimbus_git_sha: "abc",
    bun_version: "1.3.14",
    surfaces: { S1: { samples_count: 301, p95_ms: p95 } },
  };
  return JSON.stringify(line);
}

describe("parseLastHistoryLine", () => {
  test("returns the only line", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(100);
  });

  test("returns the LAST of several lines", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n${v2(200)}\n${v2(300)}\n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(300);
  });

  test("tolerates trailing blank lines / whitespace", () => {
    const out = parseLastHistoryLine(`${v2(100)}\n${v2(250)}\n\n   \n`);
    expect(out.surfaces["S1"]?.p95_ms).toBe(250);
  });

  test("throws on empty input", () => {
    expect(() => parseLastHistoryLine("   \n\n")).toThrow("run-history.jsonl is empty");
  });
});
