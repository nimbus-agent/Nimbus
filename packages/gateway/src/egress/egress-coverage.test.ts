// packages/gateway/src/egress/egress-coverage.test.ts
import { describe, expect, test } from "bun:test";
import {
  type CoverageVector,
  parseCoverage,
  serializeCoverage,
  THIS_BINARY_COVERAGE,
  weakestCoverage,
} from "./egress-coverage.ts";

const NONE: CoverageVector = {
  task: "none",
  mcp: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/**
 * The canonical serialization of `THIS_BINARY_COVERAGE`, spelled out literally so a change to
 * `COVERAGE_CLASSES` (which IS the wire order) shows up as a diff here rather than being absorbed
 * by a round-trip through `serializeCoverage`.
 *
 * Every hardcoded coverage string in this file must list ALL six classes. A string that omits one
 * makes `parseCoverage` return `null` for the MISSING-class reason, which would let a test that
 * targets some other defect keep passing while exercising nothing.
 */
const CANONICAL = "mcp=per-call;model=none;peer=none;session=none;sync=none;task=per-call";

describe("coverage vector", () => {
  test("this binary observes gated actions AND MCP-originated briefs per-call, nothing else", () => {
    // `mcp` is per-call because `recordMcpBriefEgress` ships alongside this entry. Every other
    // class stays `none` until its appender lands.
    expect(THIS_BINARY_COVERAGE).toEqual({
      task: "per-call",
      mcp: "per-call",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("serialize is stable and key-sorted", () => {
    expect(serializeCoverage(THIS_BINARY_COVERAGE)).toBe(CANONICAL);
  });

  test("parse round-trips serialize", () => {
    expect(parseCoverage(serializeCoverage(THIS_BINARY_COVERAGE))).toEqual(THIS_BINARY_COVERAGE);
  });

  test("parse returns null on malformed input rather than guessing", () => {
    expect(parseCoverage("")).toBeNull();
    expect(parseCoverage("task=banana")).toBeNull();
    expect(parseCoverage("task=per-call")).toBeNull(); // missing classes
    // A COMPLETE vector whose only defect is an unrecognized granularity — so the rejection is
    // provably about the granularity, not about a class being absent.
    expect(parseCoverage(CANONICAL.replace("task=per-call", "task=banana"))).toBeNull();
  });

  test("parse rejects an unknown key rather than silently ignoring it (fix 2)", () => {
    // A marker written by a NEWER binary carrying a class this one doesn't know must be REJECTED
    // (→ null → ALL_NONE_COVERAGE), not accepted with the unknown segment dropped — otherwise a
    // forward-incompatible marker would contribute real (understated) coverage instead of forcing
    // `indeterminate`.
    const withUnknownKey = `${serializeCoverage(THIS_BINARY_COVERAGE)};futureclass=per-call`;
    expect(parseCoverage(withUnknownKey)).toBeNull();
  });

  test("parse rejects a duplicate key rather than silently overwriting it (fix 2)", () => {
    const withDuplicate = `${serializeCoverage(THIS_BINARY_COVERAGE)};task=per-call`;
    expect(parseCoverage(withDuplicate)).toBeNull();
  });

  test("parse rejects an extra `=` in a segment rather than dropping the tail (fix 2)", () => {
    // "task=per-call=extra" must not silently parse as task="per-call" with "extra" discarded.
    //
    // The base string is asserted PARSEABLE first. Without that guard this test would pass
    // vacuously the moment COVERAGE_CLASSES grows and the literal below stops listing every class:
    // parseCoverage would return null because a class is MISSING, not because of the extra `=`,
    // and the property under test would go unexercised.
    expect(parseCoverage(CANONICAL)).not.toBeNull();
    const withExtraEquals = CANONICAL.replace("task=per-call", "task=per-call=extra");
    expect(withExtraEquals).toContain("task=per-call=extra");
    expect(parseCoverage(withExtraEquals)).toBeNull();
  });

  test("weakest takes the LOWEST granularity per class across binaries", () => {
    const rich: CoverageVector = {
      task: "per-call",
      mcp: "per-call",
      session: "per-call",
      sync: "per-run",
      model: "per-call",
      peer: "per-call",
    };
    expect(weakestCoverage([rich, THIS_BINARY_COVERAGE])).toEqual({
      task: "per-call", // both per-call
      mcp: "per-call", // both per-call
      session: "none", // this binary saw nothing
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("weakest of an empty list is all-none — claim nothing without evidence", () => {
    expect(weakestCoverage([])).toEqual(NONE);
  });
});
