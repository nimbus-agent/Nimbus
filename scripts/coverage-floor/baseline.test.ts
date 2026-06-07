import { describe, expect, test } from "bun:test";

import {
  type Baseline,
  computeBaselineDiff,
  parseBaseline,
  serializeBaseline,
} from "./baseline.ts";

describe("parseBaseline", () => {
  test("parses a v2 baseline with line+branch floors", () => {
    const json = JSON.stringify({
      version: 2,
      generated_at: "2026-06-07T00:00:00Z",
      files: { "packages/gateway/src/foo.ts": { min_line_pct: 78.6, min_branch_pct: 40 } },
    });
    const got = parseBaseline(json);
    expect(got.version).toBe(2);
    expect(got.files.get("packages/gateway/src/foo.ts")).toEqual({ line: 78.6, branch: 40 });
  });

  test("reads a legacy v1 baseline, mapping min_coverage_pct -> {line, branch:0}", () => {
    const json = JSON.stringify({
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: { "a.ts": { min_coverage_pct: 78.91 } },
    });
    const got = parseBaseline(json);
    expect(got.version).toBe(2);
    expect(got.files.get("a.ts")).toEqual({ line: 78.91, branch: 0 });
  });

  test("throws on missing version", () => {
    expect(() => parseBaseline(JSON.stringify({ files: {} }))).toThrow(/version/);
  });

  test("throws on an unsupported version (3)", () => {
    expect(() =>
      parseBaseline(JSON.stringify({ version: 3, generated_at: "x", files: {} })),
    ).toThrow(/version/);
  });

  test("throws on missing generated_at", () => {
    expect(() => parseBaseline(JSON.stringify({ version: 2, files: {} }))).toThrow(/generated_at/);
  });

  test("throws on a min_branch_pct outside 0..100", () => {
    const json = JSON.stringify({
      version: 2,
      generated_at: "x",
      files: { "a.ts": { min_line_pct: 50, min_branch_pct: 101 } },
    });
    expect(() => parseBaseline(json)).toThrow(/min_branch_pct/);
  });

  test("rejects backslash-separated paths", () => {
    const json = JSON.stringify({
      version: 2,
      generated_at: "x",
      files: { "packages\\gateway\\src\\foo.ts": { min_line_pct: 50, min_branch_pct: 0 } },
    });
    expect(() => parseBaseline(json)).toThrow(/forward slashes/);
  });
});

describe("serializeBaseline", () => {
  test("round-trips a v2 baseline", () => {
    const original: Baseline = {
      version: 2,
      generated_at: "2026-06-07T00:00:00Z",
      files: new Map([["packages/gateway/src/a.ts", { line: 78.6, branch: 40 }]]),
    };
    const reparsed = parseBaseline(serializeBaseline(original));
    expect(reparsed.files.get("packages/gateway/src/a.ts")).toEqual({ line: 78.6, branch: 40 });
  });

  test("sorts entries alphabetically and ends with a single newline", () => {
    const text = serializeBaseline({
      version: 2,
      generated_at: "x",
      files: new Map([
        ["z.ts", { line: 1, branch: 1 }],
        ["a.ts", { line: 2, branch: 2 }],
      ]),
    });
    expect(text.indexOf("a.ts")).toBeLessThan(text.indexOf("z.ts"));
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("computeBaselineDiff (dual-axis, file-level)", () => {
  const base = (line: number, branch: number): Baseline => ({
    version: 2,
    generated_at: "x",
    files: new Map([["a.ts", { line, branch }]]),
  });

  test("no diff when both axes meet their stored floors and neither is fully clear", () => {
    const diff = computeBaselineDiff(
      base(50, 40),
      new Map([["a.ts", 50]]),
      new Map([["a.ts", 40]]),
    );
    expect(diff).toEqual({ regressions: [], mustRaise: [], mustRemove: [], missingFromActual: [] });
  });

  test("flags a line regression", () => {
    const diff = computeBaselineDiff(
      base(50, 40),
      new Map([["a.ts", 45]]),
      new Map([["a.ts", 40]]),
    );
    expect(diff.regressions).toEqual([
      { path: "a.ts", dimension: "line", baseline: 50, actual: 45 },
    ]);
  });

  test("flags a branch regression", () => {
    const diff = computeBaselineDiff(
      base(50, 40),
      new Map([["a.ts", 50]]),
      new Map([["a.ts", 30]]),
    );
    expect(diff.regressions).toEqual([
      { path: "a.ts", dimension: "branch", baseline: 40, actual: 30 },
    ]);
  });

  test("flags must-remove only when BOTH axes clear the floor (>=80)", () => {
    const diff = computeBaselineDiff(
      base(50, 40),
      new Map([["a.ts", 81]]),
      new Map([["a.ts", 85]]),
    );
    expect(diff.mustRemove).toEqual([{ path: "a.ts" }]);
    expect(diff.mustRaise).toEqual([]);
  });

  test("flags must-raise (not remove) when only one axis improves and the other is still below floor", () => {
    const diff = computeBaselineDiff(
      base(50, 40),
      new Map([["a.ts", 90]]),
      new Map([["a.ts", 55]]),
    );
    expect(diff.mustRemove).toEqual([]);
    expect(diff.mustRaise).toEqual([{ path: "a.ts" }]);
  });

  test("a baseline file missing from both actual maps is a 0% regression", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map(), new Map());
    expect(diff.regressions).toEqual([
      { path: "a.ts", dimension: "line", baseline: 50, actual: 0 },
      { path: "a.ts", dimension: "branch", baseline: 40, actual: 0 },
    ]);
    expect(diff.missingFromActual).toEqual(["a.ts"]);
  });
});
