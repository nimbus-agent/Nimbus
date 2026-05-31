import { describe, expect, test } from "bun:test";

import { parseLcov } from "./lcov-parse.ts";

describe("parseLcov", () => {
  test("returns an empty map for empty input", () => {
    expect(parseLcov("").size).toBe(0);
  });

  test("returns an empty map for whitespace-only input", () => {
    expect(parseLcov("\n\n  \n").size).toBe(0);
  });

  test("parses a single record with all DA lines hit", () => {
    const lcov = [
      "TN:",
      "SF:packages/gateway/src/foo.ts",
      "DA:1,1",
      "DA:2,1",
      "DA:3,1",
      "end_of_record",
      "",
    ].join("\n");
    const got = parseLcov(lcov);
    const rec = got.get("packages/gateway/src/foo.ts");
    expect(rec).toEqual({ lines: 3, covered: 3, pct: 100 });
  });

  test("parses a record with partial coverage and computes percent to 2 decimals", () => {
    const lines = [
      "SF:packages/gateway/src/bar.ts",
      "DA:1,5",
      "DA:2,0",
      "DA:3,3",
      "DA:4,0",
      "DA:5,1",
      "DA:6,0",
      "DA:7,0",
      "end_of_record",
    ];
    const got = parseLcov(lines.join("\n"));
    const rec = got.get("packages/gateway/src/bar.ts");
    expect(rec).toEqual({ lines: 7, covered: 3, pct: 42.86 });
  });

  test("treats a record with zero DA lines as 100% (empty source)", () => {
    const lcov = "SF:packages/gateway/src/types/empty.ts\nend_of_record\n";
    const rec = parseLcov(lcov).get("packages/gateway/src/types/empty.ts");
    expect(rec).toEqual({ lines: 0, covered: 0, pct: 100 });
  });

  test("parses multiple consecutive records", () => {
    const lcov = [
      "SF:a.ts",
      "DA:1,1",
      "end_of_record",
      "SF:b.ts",
      "DA:1,0",
      "DA:2,1",
      "end_of_record",
      "",
    ].join("\n");
    const got = parseLcov(lcov);
    expect(got.get("a.ts")).toEqual({ lines: 1, covered: 1, pct: 100 });
    expect(got.get("b.ts")).toEqual({ lines: 2, covered: 1, pct: 50 });
  });

  test("ignores non-DA/SF lines (BRDA, FN, etc. are not used by the floor)", () => {
    const lcov = [
      "SF:c.ts",
      "FN:1,fooFunc",
      "FNDA:1,fooFunc",
      "FNF:1",
      "FNH:1",
      "DA:1,1",
      "DA:2,0",
      "BRDA:1,0,0,1",
      "LF:2",
      "LH:1",
      "end_of_record",
    ].join("\n");
    const rec = parseLcov(lcov).get("c.ts");
    expect(rec).toEqual({ lines: 2, covered: 1, pct: 50 });
  });

  test("normalizes backslashes in SF paths to forward slashes", () => {
    const lcov = "SF:packages\\gateway\\src\\foo.ts\nDA:1,1\nend_of_record\n";
    const got = parseLcov(lcov);
    expect(got.has("packages/gateway/src/foo.ts")).toBe(true);
    expect(got.has("packages\\gateway\\src\\foo.ts")).toBe(false);
  });

  test("a duplicate SF record (re-emitted from a second test run) keeps the last record", () => {
    const lcov = ["SF:a.ts", "DA:1,0", "end_of_record", "SF:a.ts", "DA:1,1", "end_of_record"].join(
      "\n",
    );
    expect(parseLcov(lcov).get("a.ts")?.pct).toBe(100);
  });
});
