import { describe, expect, test } from "bun:test";

import {
  type Baseline,
  computeBaselineDiff,
  parseBaseline,
  serializeBaseline,
} from "./baseline.ts";

describe("parseBaseline", () => {
  test("parses a minimal valid baseline", () => {
    const json = JSON.stringify({
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: { "packages/gateway/src/foo.ts": { min_coverage_pct: 4.35 } },
    });
    const got = parseBaseline(json);
    expect(got.files.get("packages/gateway/src/foo.ts")).toBe(4.35);
    expect(got.version).toBe(1);
  });

  test("throws on missing version", () => {
    expect(() => parseBaseline(JSON.stringify({ files: {} }))).toThrow(/version/);
  });

  test("throws on unsupported version", () => {
    expect(() =>
      parseBaseline(JSON.stringify({ version: 2, generated_at: "x", files: {} })),
    ).toThrow(/version/);
  });

  test("throws on missing generated_at", () => {
    expect(() => parseBaseline(JSON.stringify({ version: 1, files: {} }))).toThrow(/generated_at/);
  });

  test("throws on a min_coverage_pct outside 0..100", () => {
    const json = JSON.stringify({
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: { "a.ts": { min_coverage_pct: 101 } },
    });
    expect(() => parseBaseline(json)).toThrow(/min_coverage_pct/);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseBaseline("not json")).toThrow();
  });

  test("rejects backslash-separated paths with an actionable error", () => {
    const json = JSON.stringify({
      version: 1,
      generated_at: "x",
      files: { "packages\\gateway\\src\\foo.ts": { min_coverage_pct: 50 } },
    });
    expect(() => parseBaseline(json)).toThrow(/use forward slashes/);
  });
});

describe("serializeBaseline", () => {
  test("round-trips through parseBaseline", () => {
    const original: Baseline = {
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: new Map([
        ["packages/gateway/src/a.ts", 4.35],
        ["packages/gateway/src/b.ts", 30],
      ]),
    };
    const text = serializeBaseline(original);
    const reparsed = parseBaseline(text);
    expect(reparsed.files.get("packages/gateway/src/a.ts")).toBe(4.35);
    expect(reparsed.files.get("packages/gateway/src/b.ts")).toBe(30);
  });

  test("sorts file entries alphabetically for stable diffs", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: new Map([
        ["z/last.ts", 10],
        ["a/first.ts", 20],
        ["m/mid.ts", 30],
      ]),
    };
    const text = serializeBaseline(baseline);
    const firstIdx = text.indexOf("a/first.ts");
    const midIdx = text.indexOf("m/mid.ts");
    const lastIdx = text.indexOf("z/last.ts");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(midIdx).toBeGreaterThan(firstIdx);
    expect(lastIdx).toBeGreaterThan(midIdx);
  });

  test("ends with a single trailing newline", () => {
    const text = serializeBaseline({
      version: 1,
      generated_at: "2026-05-17T00:00:00Z",
      files: new Map(),
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("computeBaselineDiff", () => {
  test("returns empty diff when actual matches baseline", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "x",
      files: new Map([["a.ts", 50]]),
    };
    const actual = new Map<string, number>([["a.ts", 50]]);
    expect(computeBaselineDiff(baseline, actual)).toEqual({
      regressions: [],
      mustRaise: [],
      mustRemove: [],
      missingFromActual: [],
    });
  });

  test("flags a regression when actual < baseline", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "x",
      files: new Map([["a.ts", 50]]),
    };
    const actual = new Map<string, number>([["a.ts", 40]]);
    const diff = computeBaselineDiff(baseline, actual);
    expect(diff.regressions).toEqual([{ path: "a.ts", baseline: 50, actual: 40 }]);
  });

  test("flags must-raise when actual > baseline and < 80", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "x",
      files: new Map([["a.ts", 40]]),
    };
    const actual = new Map<string, number>([["a.ts", 65]]);
    const diff = computeBaselineDiff(baseline, actual);
    expect(diff.mustRaise).toEqual([{ path: "a.ts", baseline: 40, actual: 65 }]);
  });

  test("flags must-remove when actual >= 80", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "x",
      files: new Map([["a.ts", 40]]),
    };
    const actual = new Map<string, number>([["a.ts", 82.5]]);
    const diff = computeBaselineDiff(baseline, actual);
    expect(diff.mustRemove).toEqual([{ path: "a.ts", actual: 82.5 }]);
    expect(diff.mustRaise).toEqual([]);
  });

  test("flags a baseline file missing from actual lcov (treated as 0%)", () => {
    const baseline: Baseline = {
      version: 1,
      generated_at: "x",
      files: new Map([["a.ts", 40]]),
    };
    const actual = new Map<string, number>();
    const diff = computeBaselineDiff(baseline, actual);
    expect(diff.regressions).toEqual([{ path: "a.ts", baseline: 40, actual: 0 }]);
    expect(diff.missingFromActual).toEqual(["a.ts"]);
  });
});
