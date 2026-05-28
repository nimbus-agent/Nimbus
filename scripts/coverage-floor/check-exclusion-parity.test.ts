import { describe, expect, test } from "bun:test";

import { findParityGaps } from "./check-exclusion-parity.ts";

describe("findParityGaps", () => {
  test("returns empty when both sides agree (every sonar pattern is exempt locally)", () => {
    const sonarPatterns = ["**/index/*-v[0-9]*-sql.ts", "packages/gateway/src/perf/**"];
    expect(findParityGaps(sonarPatterns)).toEqual([]);
  });

  test("reports a pattern that has no local exemption equivalent", () => {
    const sonarPatterns = ["**/should-not-match-any-exemption/**"];
    const gaps = findParityGaps(sonarPatterns);
    expect(gaps).toContain("**/should-not-match-any-exemption/**");
  });

  test("permits sonar patterns that are subsets of local exemptions", () => {
    expect(findParityGaps(["packages/gateway/src/perf/fixtures/foo.ts"])).toEqual([]);
  });
});
