import { describe, expect, test } from "bun:test";

import type { Baseline } from "./baseline.ts";
import { computeUpdatedBaseline, evaluateCheck } from "./check.ts";

const emptyBaseline: Baseline = { version: 2, generated_at: "x", files: new Map() };

describe("evaluateCheck (dual-axis)", () => {
  test("passes when a non-baselined file meets both floors", () => {
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/a.ts"],
      actualLine: new Map([["packages/gateway/src/a.ts", 95]]),
      actualBranch: new Map([["packages/gateway/src/a.ts", 88]]),
      baseline: emptyBaseline,
    });
    expect(r.exitCode).toBe(0);
    expect(r.violations).toEqual([]);
  });

  test("flags below_floor on the branch axis for a non-baselined file", () => {
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/a.ts"],
      actualLine: new Map([["packages/gateway/src/a.ts", 95]]),
      actualBranch: new Map([["packages/gateway/src/a.ts", 60]]),
      baseline: emptyBaseline,
    });
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual({
      kind: "below_floor",
      dimension: "branch",
      path: "packages/gateway/src/a.ts",
      actual: 60,
    });
  });

  test("flags missing_from_lcov when a non-baselined source file has no line data", () => {
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/a.ts"],
      actualLine: new Map(),
      actualBranch: new Map(),
      baseline: emptyBaseline,
    });
    expect(r.violations).toContainEqual({
      kind: "missing_from_lcov",
      path: "packages/gateway/src/a.ts",
    });
  });

  test("skips the floor check for a baselined file but applies the ratchet", () => {
    const baseline: Baseline = {
      version: 2,
      generated_at: "x",
      files: new Map([["packages/gateway/src/a.ts", { line: 78, branch: 40 }]]),
    };
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/a.ts"],
      actualLine: new Map([["packages/gateway/src/a.ts", 78]]),
      actualBranch: new Map([["packages/gateway/src/a.ts", 40]]),
      baseline,
    });
    expect(r.exitCode).toBe(0);
  });

  test("ignores exempt files", () => {
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/vault/win32.ts"],
      actualLine: new Map(),
      actualBranch: new Map(),
      baseline: emptyBaseline,
    });
    expect(r.violations).toEqual([]);
  });
});

describe("computeUpdatedBaseline (dual-axis)", () => {
  test("captures a sub-floor file at its actuals; satisfied axis pinned at the floor", () => {
    const next = computeUpdatedBaseline(
      { version: 2, generated_at: "x", files: new Map() },
      new Map([["packages/gateway/src/a.ts", 90]]), // line satisfied
      new Map([["packages/gateway/src/a.ts", 55]]), // branch below floor
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.get("packages/gateway/src/a.ts")).toEqual({ line: 80, branch: 55 });
  });

  test("drops a file once BOTH axes clear the floor", () => {
    const next = computeUpdatedBaseline(
      {
        version: 2,
        generated_at: "x",
        files: new Map([["packages/gateway/src/a.ts", { line: 78, branch: 40 }]]),
      },
      new Map([["packages/gateway/src/a.ts", 85]]),
      new Map([["packages/gateway/src/a.ts", 82]]),
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.has("packages/gateway/src/a.ts")).toBe(false);
  });

  test("ratchets an unsatisfied axis up to its actual but never down", () => {
    const next = computeUpdatedBaseline(
      {
        version: 2,
        generated_at: "x",
        files: new Map([["packages/gateway/src/a.ts", { line: 50, branch: 30 }]]),
      },
      new Map([["packages/gateway/src/a.ts", 60]]),
      new Map([["packages/gateway/src/a.ts", 20]]), // dropped below stored — keep the higher watermark
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.get("packages/gateway/src/a.ts")).toEqual({ line: 60, branch: 30 });
  });
});
