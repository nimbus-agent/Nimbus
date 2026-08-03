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
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

describe("coverage vector", () => {
  test("Phase 1 binary observes gated actions per-call and nothing else", () => {
    expect(THIS_BINARY_COVERAGE).toEqual({
      task: "per-call",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("serialize is stable and key-sorted", () => {
    expect(serializeCoverage(THIS_BINARY_COVERAGE)).toBe(
      "model=none;peer=none;session=none;sync=none;task=per-call",
    );
  });

  test("parse round-trips serialize", () => {
    expect(parseCoverage(serializeCoverage(THIS_BINARY_COVERAGE))).toEqual(THIS_BINARY_COVERAGE);
  });

  test("parse returns null on malformed input rather than guessing", () => {
    expect(parseCoverage("")).toBeNull();
    expect(parseCoverage("task=banana")).toBeNull();
    expect(parseCoverage("task=per-call")).toBeNull(); // missing classes
  });

  test("weakest takes the LOWEST granularity per class across binaries", () => {
    const rich: CoverageVector = {
      task: "per-call",
      session: "per-call",
      sync: "per-run",
      model: "per-call",
      peer: "per-call",
    };
    expect(weakestCoverage([rich, THIS_BINARY_COVERAGE])).toEqual({
      task: "per-call", // both per-call
      session: "none", // Phase 1 binary saw nothing
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("weakest of an empty list is all-none — claim nothing without evidence", () => {
    expect(weakestCoverage([])).toEqual(NONE);
  });
});
