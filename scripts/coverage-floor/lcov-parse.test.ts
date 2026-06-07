import { describe, expect, test } from "bun:test";

import { parseLcov } from "./lcov-parse.ts";

describe("parseLcov", () => {
  test("returns an empty map for empty input", () => {
    expect(parseLcov("").size).toBe(0);
  });

  test("returns an empty map for whitespace-only input", () => {
    expect(parseLcov("\n\n  \n").size).toBe(0);
  });

  test("parses a single record with all DA lines hit (no branches => 100% branch)", () => {
    const lcov = [
      "TN:",
      "SF:packages/gateway/src/foo.ts",
      "DA:1,1",
      "DA:2,1",
      "DA:3,1",
      "end_of_record",
      "",
    ].join("\n");
    const rec = parseLcov(lcov).get("packages/gateway/src/foo.ts");
    expect(rec).toEqual({
      lines: 3,
      covered: 3,
      pct: 100,
      branches: 0,
      branchesHit: 0,
      branchPct: 100,
    });
  });

  test("computes line percent to 2 decimals", () => {
    const lcov = [
      "SF:packages/gateway/src/bar.ts",
      "DA:1,5",
      "DA:2,0",
      "DA:3,3",
      "DA:4,0",
      "DA:5,1",
      "DA:6,0",
      "DA:7,0",
      "end_of_record",
    ].join("\n");
    const rec = parseLcov(lcov).get("packages/gateway/src/bar.ts");
    expect(rec).toEqual({
      lines: 7,
      covered: 3,
      pct: 42.86,
      branches: 0,
      branchesHit: 0,
      branchPct: 100,
    });
  });

  test("treats a record with zero DA lines as 100% line and 100% branch", () => {
    const rec = parseLcov("SF:packages/gateway/src/types/empty.ts\nend_of_record\n").get(
      "packages/gateway/src/types/empty.ts",
    );
    expect(rec).toEqual({
      lines: 0,
      covered: 0,
      pct: 100,
      branches: 0,
      branchesHit: 0,
      branchPct: 100,
    });
  });

  test("parses BRDA branch records: taken '>0' is hit, '0' and '-' are misses", () => {
    const lcov = [
      "SF:c.ts",
      "DA:1,1",
      "DA:2,0",
      "BRDA:1,0,0,1", // hit
      "BRDA:1,0,1,0", // miss (taken 0)
      "BRDA:2,0,0,-", // miss (not reached)
      "BRF:3",
      "BRH:1",
      "end_of_record",
    ].join("\n");
    const rec = parseLcov(lcov).get("c.ts");
    expect(rec).toEqual({
      lines: 2,
      covered: 1,
      pct: 50,
      branches: 3,
      branchesHit: 1,
      branchPct: 33.33,
    });
  });

  test("a fully covered branch set yields 100% branch", () => {
    const lcov = ["SF:d.ts", "DA:1,1", "BRDA:1,0,0,2", "BRDA:1,0,1,3", "end_of_record"].join("\n");
    const rec = parseLcov(lcov).get("d.ts");
    expect(rec?.branches).toBe(2);
    expect(rec?.branchesHit).toBe(2);
    expect(rec?.branchPct).toBe(100);
  });

  test("normalizes backslashes in SF paths to forward slashes", () => {
    const got = parseLcov("SF:packages\\gateway\\src\\foo.ts\nDA:1,1\nend_of_record\n");
    expect(got.has("packages/gateway/src/foo.ts")).toBe(true);
  });

  test("a duplicate SF record keeps the last record (line and branch reset between records)", () => {
    const lcov = [
      "SF:a.ts",
      "DA:1,0",
      "BRDA:1,0,0,-",
      "end_of_record",
      "SF:a.ts",
      "DA:1,1",
      "BRDA:1,0,0,1",
      "end_of_record",
    ].join("\n");
    const rec = parseLcov(lcov).get("a.ts");
    expect(rec).toEqual({
      lines: 1,
      covered: 1,
      pct: 100,
      branches: 1,
      branchesHit: 1,
      branchPct: 100,
    });
  });
});
