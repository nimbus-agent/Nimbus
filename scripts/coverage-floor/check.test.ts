import { describe, expect, test } from "bun:test";

import type { Baseline } from "./baseline.ts";
import {
  computeUpdatedBaseline,
  discoverSourceFiles,
  evaluateCheck,
  lcovHasBranchData,
} from "./check.ts";
import { parseLcov } from "./lcov-parse.ts";

const emptyBaseline: Baseline = {
  version: 2,
  generated_at: "x",
  files: new Map(),
  targets: new Map(),
};

describe("lcovHasBranchData (instrumentation canary)", () => {
  test("true when at least one file carries BRDA branch records", () => {
    const parsed = parseLcov("SF:packages/gateway/src/a.ts\nDA:1,1\nBRDA:1,0,0,1\nend_of_record\n");
    expect(lcovHasBranchData(parsed)).toBe(true);
  });

  test("false when files have line data but ZERO branch records (broken instrumentation → false 100%)", () => {
    const parsed = parseLcov("SF:packages/gateway/src/a.ts\nDA:1,1\nDA:2,1\nend_of_record\n");
    expect(parsed.size).toBe(1);
    expect(lcovHasBranchData(parsed)).toBe(false);
  });

  test("true for an empty lcov (a different failure — handled by missing_from_lcov / lcov-not-found)", () => {
    expect(lcovHasBranchData(parseLcov(""))).toBe(true);
  });
});

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
      targets: new Map(),
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

describe("evaluateCheck — flagship 100% targets overlay", () => {
  const FLAGSHIP = "packages/gateway/src/engine/executor.ts";
  const withTarget = (line: number, branch: number): Baseline => ({
    version: 2,
    generated_at: "x",
    files: new Map(),
    targets: new Map([[FLAGSHIP, { line, branch }]]),
  });

  test("passes when a targeted file meets its 100/100 ceiling", () => {
    const r = evaluateCheck({
      sourceFiles: [FLAGSHIP],
      actualLine: new Map([[FLAGSHIP, 100]]),
      actualBranch: new Map([[FLAGSHIP, 100]]),
      baseline: withTarget(100, 100),
    });
    expect(r.exitCode).toBe(0);
    expect(r.violations).toEqual([]);
  });

  test("flags below_target on the line axis when a pinned file slips to 99", () => {
    const r = evaluateCheck({
      sourceFiles: [FLAGSHIP],
      actualLine: new Map([[FLAGSHIP, 99]]),
      actualBranch: new Map([[FLAGSHIP, 100]]),
      baseline: withTarget(100, 100),
    });
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual({
      kind: "below_target",
      dimension: "line",
      path: FLAGSHIP,
      actual: 99,
      required: 100,
    });
  });

  test("flags below_target on the branch axis when a pinned file drops one branch", () => {
    const r = evaluateCheck({
      sourceFiles: [FLAGSHIP],
      actualLine: new Map([[FLAGSHIP, 100]]),
      actualBranch: new Map([[FLAGSHIP, 97.7]]),
      baseline: withTarget(100, 100),
    });
    expect(r.violations).toContainEqual({
      kind: "below_target",
      dimension: "branch",
      path: FLAGSHIP,
      actual: 97.7,
      required: 100,
    });
  });

  test("fail-closed: a targeted file missing from the lcov reads as 0% line (below_target)", () => {
    const r = evaluateCheck({
      sourceFiles: [FLAGSHIP],
      actualLine: new Map(),
      actualBranch: new Map(),
      baseline: withTarget(100, 100),
    });
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual({
      kind: "below_target",
      dimension: "line",
      path: FLAGSHIP,
      actual: 0,
      required: 100,
    });
  });

  test("a passing target sits ABOVE the floor pass — no below_floor, no must_* churn", () => {
    // The same file clears the 85 floor AND its 100 target: exactly zero violations, proving the
    // overlay is purely additive (it never double-reports or interferes with the ratchet).
    const r = evaluateCheck({
      sourceFiles: [FLAGSHIP],
      actualLine: new Map([[FLAGSHIP, 100]]),
      actualBranch: new Map([[FLAGSHIP, 100]]),
      baseline: withTarget(100, 100),
    });
    expect(r.violations).toEqual([]);
  });
});

describe("discoverSourceFiles — structural exemptions", () => {
  test("never yields a file under a /testing/ dir (relocated test-helpers are auto-skipped)", async () => {
    // Test-helper/fixture files live under `testing/` dirs; the skip in discoverSourceFiles
    // is the exemption (replacing the former explicit EXCLUSIONS entries). The relocated B0
    // helpers (e.g. cli/src/commands/testing/cli-test-helpers.ts) must not appear here.
    const files = await discoverSourceFiles();
    expect(files.some((f) => f.includes("/testing/"))).toBe(false);
  });

  /**
   * Discovery and instrumentation must agree on what a test file is.
   * `shouldInstrument` skips both `.test.` and `.spec.`; this pass only skipped
   * `.test.`, so a `*.spec.ts` would be discovered as SOURCE, never
   * instrumented, and then reported `missing_from_lcov` at 0% — a false failure
   * on a file that is not source. Bun treats `.spec` as a test marker exactly as
   * it treats `.test`.
   */
  test("never yields a test file, by either naming convention", async () => {
    const files = await discoverSourceFiles();
    const offenders = files.filter((f) => /\.(test|spec)\.tsx?$/.test(f));
    expect(offenders).toEqual([]);
  });

  test("does discover ordinary source, so the filters above are not vacuous", async () => {
    const files = await discoverSourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("packages/gateway/src/engine/executor.ts");
  });
});

describe("computeUpdatedBaseline (dual-axis)", () => {
  test("captures a sub-floor file at its actuals; satisfied axis pinned at the floor", () => {
    const next = computeUpdatedBaseline(
      { version: 2, generated_at: "x", files: new Map(), targets: new Map() },
      new Map([["packages/gateway/src/a.ts", 90]]), // line satisfied
      new Map([["packages/gateway/src/a.ts", 55]]), // branch below floor
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.get("packages/gateway/src/a.ts")).toEqual({ line: 85, branch: 55 });
  });

  test("drops a file once BOTH axes clear the floor", () => {
    const next = computeUpdatedBaseline(
      {
        version: 2,
        generated_at: "x",
        files: new Map([["packages/gateway/src/a.ts", { line: 78, branch: 40 }]]),
        targets: new Map(),
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
        targets: new Map(),
      },
      new Map([["packages/gateway/src/a.ts", 60]]),
      new Map([["packages/gateway/src/a.ts", 20]]), // dropped below stored — keep the higher watermark
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.get("packages/gateway/src/a.ts")).toEqual({ line: 60, branch: 30 });
  });

  test("round-trips the flagship targets section verbatim (a reseed never drops a 100% ceiling)", () => {
    const targets = new Map([
      ["packages/gateway/src/engine/executor.ts", { line: 100, branch: 100 }],
    ]);
    const next = computeUpdatedBaseline(
      { version: 2, generated_at: "x", files: new Map(), targets },
      // executor.ts clears both floors at 100/100, so the ratchet drops it from `files`...
      new Map([["packages/gateway/src/engine/executor.ts", 100]]),
      new Map([["packages/gateway/src/engine/executor.ts", 100]]),
      ["packages/gateway/src/engine/executor.ts"],
      "now",
    );
    expect(next.files.has("packages/gateway/src/engine/executor.ts")).toBe(false);
    // ...but it stays pinned in `targets`, untouched.
    expect(next.targets).toBe(targets);
    expect(next.targets.get("packages/gateway/src/engine/executor.ts")).toEqual({
      line: 100,
      branch: 100,
    });
  });
});
