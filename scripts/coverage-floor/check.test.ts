import { describe, expect, test } from "bun:test";

import { type EvaluateInput, evaluateCheck } from "./check.ts";

const emptyBaseline = {
  version: 1 as const,
  generated_at: "2026-05-17T00:00:00Z",
  files: new Map<string, number>(),
};

function inputWith(overrides: Partial<EvaluateInput>): EvaluateInput {
  return {
    sourceFiles: [],
    actual: new Map(),
    baseline: emptyBaseline,
    ...overrides,
  };
}

describe("evaluateCheck — green paths", () => {
  test("empty workspace passes", () => {
    const r = evaluateCheck(inputWith({}));
    expect(r.exitCode).toBe(0);
    expect(r.violations).toEqual([]);
  });

  test("a non-baseline file at 80% passes", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["packages/gateway/src/foo.ts"],
        actual: new Map([["packages/gateway/src/foo.ts", 80]]),
      }),
    );
    expect(r.exitCode).toBe(0);
  });

  test("a baseline file at its watermark passes", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["packages/gateway/src/foo.ts"],
        actual: new Map([["packages/gateway/src/foo.ts", 40]]),
        baseline: {
          version: 1,
          generated_at: "x",
          files: new Map([["packages/gateway/src/foo.ts", 40]]),
        },
      }),
    );
    expect(r.exitCode).toBe(0);
  });

  test("an exempt file with no coverage passes (skipped entirely)", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["packages/gateway/src/vault/win32.ts"],
        actual: new Map(), // no lcov entry
      }),
    );
    expect(r.exitCode).toBe(0);
  });
});

describe("evaluateCheck — non-baseline file violations", () => {
  test("non-baseline file at 79.99% fails (below floor)", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["packages/gateway/src/foo.ts"],
        actual: new Map([["packages/gateway/src/foo.ts", 79.99]]),
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual(
      expect.objectContaining({
        kind: "below_floor",
        path: "packages/gateway/src/foo.ts",
        actual: 79.99,
      }),
    );
  });

  test("a non-exempt source file missing from lcov fails (treated as 0%)", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["packages/gateway/src/untested.ts"],
        actual: new Map(),
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual(
      expect.objectContaining({
        kind: "missing_from_lcov",
        path: "packages/gateway/src/untested.ts",
      }),
    );
  });
});

describe("evaluateCheck — baseline ratchet violations", () => {
  test("regression below baseline fails", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["a.ts"],
        actual: new Map([["a.ts", 30]]),
        baseline: {
          version: 1,
          generated_at: "x",
          files: new Map([["a.ts", 40]]),
        },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ kind: "regression", path: "a.ts" }),
    );
  });

  test("must-raise without baseline update fails (rule 3)", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["a.ts"],
        actual: new Map([["a.ts", 65]]),
        baseline: {
          version: 1,
          generated_at: "x",
          files: new Map([["a.ts", 40]]),
        },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ kind: "must_raise", path: "a.ts" }),
    );
  });

  test("must-remove without baseline removal fails (rule 4)", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: ["a.ts"],
        actual: new Map([["a.ts", 85]]),
        baseline: {
          version: 1,
          generated_at: "x",
          files: new Map([["a.ts", 40]]),
        },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ kind: "must_remove", path: "a.ts" }),
    );
  });
});

describe("evaluateCheck — exemptions and test-file filtering", () => {
  test("exempt files in the source list are skipped even when their actual coverage is < 80", () => {
    const r = evaluateCheck(
      inputWith({
        sourceFiles: [
          "packages/gateway/src/vault/win32.ts",
          "packages/gateway/src/perf/bench-cli.ts",
        ],
        actual: new Map([
          ["packages/gateway/src/vault/win32.ts", 10],
          ["packages/gateway/src/perf/bench-cli.ts", 0],
        ]),
      }),
    );
    expect(r.exitCode).toBe(0);
  });
});

describe("computeUpdatedBaseline (--update-baseline mode)", () => {
  test("raises must-raise entries and drops must-remove entries", async () => {
    const { computeUpdatedBaseline } = await import("./check.ts");
    const baseline = {
      version: 1 as const,
      generated_at: "old",
      files: new Map([
        ["raise.ts", 40],
        ["remove.ts", 30],
        ["stable.ts", 50],
        ["regress.ts", 50], // regressions are NOT auto-fixed
      ]),
    };
    const actual = new Map<string, number>([
      ["raise.ts", 70],
      ["remove.ts", 85],
      ["stable.ts", 50],
      ["regress.ts", 30],
    ]);
    const updated = computeUpdatedBaseline(baseline, actual, [], "new-timestamp");
    expect(updated.files.get("raise.ts")).toBe(70);
    expect(updated.files.has("remove.ts")).toBe(false);
    expect(updated.files.get("stable.ts")).toBe(50);
    expect(updated.files.get("regress.ts")).toBe(50);
    expect(updated.generated_at).toBe("new-timestamp");
  });

  test("seeds new non-exempt below-floor files from sourceFiles", async () => {
    const { computeUpdatedBaseline } = await import("./check.ts");
    const baseline = {
      version: 1 as const,
      generated_at: "old",
      files: new Map<string, number>(),
    };
    const actual = new Map<string, number>([
      ["packages/gateway/src/foo.ts", 35],
      ["packages/gateway/src/bar.ts", 90], // passes floor → not seeded
    ]);
    const sourceFiles = [
      "packages/gateway/src/foo.ts",
      "packages/gateway/src/bar.ts",
      "packages/gateway/src/baz.ts", // not in actual → seeded at 0
    ];
    const updated = computeUpdatedBaseline(baseline, actual, sourceFiles, "new");
    expect(updated.files.get("packages/gateway/src/foo.ts")).toBe(35);
    expect(updated.files.has("packages/gateway/src/bar.ts")).toBe(false);
    expect(updated.files.get("packages/gateway/src/baz.ts")).toBe(0);
  });

  test("skips exempt files during seeding", async () => {
    const { computeUpdatedBaseline } = await import("./check.ts");
    const baseline = {
      version: 1 as const,
      generated_at: "old",
      files: new Map<string, number>(),
    };
    const actual = new Map<string, number>([
      ["packages/gateway/src/vault/win32.ts", 5], // exempt
      ["packages/gateway/src/perf/bench-cli.ts", 0], // exempt
    ]);
    const sourceFiles = [
      "packages/gateway/src/vault/win32.ts",
      "packages/gateway/src/perf/bench-cli.ts",
    ];
    const updated = computeUpdatedBaseline(baseline, actual, sourceFiles, "new");
    expect(updated.files.size).toBe(0);
  });

  test("does not duplicate an already-baselined entry during seeding", async () => {
    const { computeUpdatedBaseline } = await import("./check.ts");
    const baseline = {
      version: 1 as const,
      generated_at: "old",
      files: new Map([["a.ts", 40]]),
    };
    const actual = new Map<string, number>([["a.ts", 50]]);
    const sourceFiles = ["a.ts"];
    const updated = computeUpdatedBaseline(baseline, actual, sourceFiles, "new");
    expect(updated.files.get("a.ts")).toBe(50);
    expect(updated.files.size).toBe(1);
  });
});

describe("discoverSourceFiles — package scope", () => {
  test("only walks bun-tested packages (excludes ui/vscode-extension/docs)", async () => {
    const { discoverSourceFiles } = await import("./check.ts");
    const files = await discoverSourceFiles();
    expect(files.every((p) => !p.startsWith("packages/ui/"))).toBe(true);
    expect(files.every((p) => !p.startsWith("packages/vscode-extension/"))).toBe(true);
    expect(files.every((p) => !p.startsWith("packages/docs/"))).toBe(true);
    expect(files.some((p) => p.startsWith("packages/gateway/src/"))).toBe(true);
  });
});
