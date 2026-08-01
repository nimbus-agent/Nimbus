import { describe, expect, test } from "bun:test";

import { findParityGaps } from "./check-exclusion-parity.ts";

describe("findParityGaps", () => {
  test("returns empty when both sides agree (every sonar pattern is exempt locally)", () => {
    const sonarPatterns = ["**/perf/surfaces/**", "**/packages/github-actions/*/src/main.ts"];
    expect(findParityGaps(sonarPatterns)).toEqual([]);
  });

  test("reports a pattern whose local counterpart was retired (the deletion trap)", () => {
    // `**/index/*-v[0-9]*-sql.ts` was dropped from BOTH sides on 2026-08-01. Dropping it from
    // exclusions.ts alone is the mistake this gate exists to catch, so it must read as a gap now.
    expect(findParityGaps(["**/index/*-v[0-9]*-sql.ts"])).toEqual(["**/index/*-v[0-9]*-sql.ts"]);
  });

  test("reports a pattern that has no local exemption equivalent", () => {
    const sonarPatterns = ["**/should-not-match-any-exemption/**"];
    const gaps = findParityGaps(sonarPatterns);
    expect(gaps).toContain("**/should-not-match-any-exemption/**");
  });

  test("permits sonar patterns that are subsets of local exemptions", () => {
    expect(findParityGaps(["packages/gateway/src/perf/surfaces/bench-cold-start.ts"])).toEqual([]);
  });

  test("treats a /testing/ path as covered even when it is not in EXCLUSIONS", () => {
    // a /testing/ path is exempt structurally via discoverSourceFiles (check.ts),
    // not via isExempt; the parity check must still consider it covered.
    expect(findParityGaps(["packages/gateway/src/testing/sandbox-probe.ts"])).toEqual([]);
  });

  test("still reports a genuinely-uncovered non-testing path (no over-broadening)", () => {
    const gaps = findParityGaps(["packages/gateway/src/some-real-file.ts"]);
    expect(gaps).toContain("packages/gateway/src/some-real-file.ts");
  });
});
