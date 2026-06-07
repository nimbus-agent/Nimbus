# Branch-Coverage Foundation (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real per-file **branch** coverage to the Nimbus gate by instrumenting `bun test` with Istanbul (source instrumentation), and extend the existing ratcheting coverage-floor into a dual **line + branch** gate.

**Architecture:** A Bun `[test].preload` onLoad plugin transforms first-party `src` TS/TSX with `@babel/preset-typescript` + `babel-plugin-istanbul` (`retainLines`), collecting line+branch counts on `globalThis.__coverage__`. A second preload dumps that map to a per-process JSON; a merge step unions all shards into one `coverage/lcov.info` carrying `BRDA` records. The existing `scripts/coverage-floor/*` parser/baseline/check are widened to a two-axis ratchet (line floor 80, branch floor 80). SonarCloud auto-ingests the new `BRDA` data with no config change. The fast dev-loop `bun test` stays uninstrumented.

**Tech Stack:** Bun 1.3.14 (JavaScriptCore), TypeScript 6.x strict, Biome, `@babel/core` + `@babel/preset-typescript` + `babel-plugin-istanbul`, `istanbul-lib-coverage` + `istanbul-lib-report` + `istanbul-reports`.

**Design spec:** [`docs/superpowers/specs/2026-06-07-true-coverage-program-design.md`](../specs/2026-06-07-true-coverage-program-design.md) (§5 = this sub-project; review dispositions in §12).

---

## Background the engineer needs

- **Why Istanbul, not Bun?** `bun test --coverage` emits **no** `BRDA` branch records (verified; Bun issue #7100 open). Istanbul *source* instrumentation is runtime-agnostic, so it works under Bun's JSC. `c8`/`NODE_V8_COVERAGE` is impossible (Bun isn't V8). Do **not** use `istanbul-lib-instrument` + `Bun.Transpiler` (that path skews line numbers); the `babel-plugin-istanbul` + `retainLines` path has exact line fidelity.
- **lcov records:** `DA:<line>,<hits>` = line; `BRDA:<line>,<block>,<branch>,<taken>` = one branch outcome, `<taken>` is `-` (not reached) or a hit count. `BRF`/`BRH` = branch found/hit totals.
- **The ratchet:** `docs/structure-audit/coverage-baseline.json` lists files **below** the floor with a min watermark; the gate fails on regression below the watermark, demands the watermark rise when coverage improves, and demands removal once a file clears the floor. We extend this from one number per file to a `{line, branch}` tuple.
- **Linux-authoritative:** the gate runs on CI-Linux only; branch coverage of platform-gated files differs per OS, so the committed baseline must be seeded from **CI-Linux** lcov (Task 10). Local Windows runs are approximate.
- **Preload gotchas (proven in the spike):** `bun test` ignores top-level `preload` in `bunfig.toml` — use `[test].preload`. A broad onLoad filter crashes Babel internals — scope-gate to first-party `src` only and import the preset/plugin as **function references** (never string names). `onLoad` must always return an object. `.tsx` must return the `jsx` loader. Flush coverage from a global `afterAll` (process exit hooks never fire under `bun test`).

## File map (created / modified)

**Created:**
- `scripts/coverage/instrument-scope.ts` — `shouldInstrument(absPath)` predicate (first-party src only).
- `scripts/coverage/instrument-scope.test.ts` — its tests.
- `scripts/coverage/istanbul-register.ts` — the instrumentation preload (Babel + istanbul onLoad).
- `scripts/coverage/report-coverage.ts` — the flush preload (`afterAll` → `coverage/.nyc-tmp/<pid>.json`).
- `scripts/coverage/merge-coverage.ts` — merge shards → `coverage/lcov.info`.
- `scripts/coverage/merge-coverage.test.ts` — its tests.
- `scripts/coverage/__fixtures__/sample/` — a tiny instrumented-coverage fixture (Task 4 verification).

**Modified:**
- `scripts/coverage-floor/lcov-parse.ts` (+ `.test.ts`) — parse `BRDA` → `branchPct`.
- `scripts/coverage-floor/baseline.ts` (+ `.test.ts`) — v2 `{line,branch}` schema + v1→v2 read shim + dual-axis `computeBaselineDiff`.
- `scripts/coverage-floor/check.ts` — dual-axis `evaluateCheck`/`computeUpdatedBaseline` + dimension-tagged violations.
- `scripts/coverage-floor/build-lcov.sh` — drive the instrumented run + merge.
- `scripts/coverage-floor/exclusions.ts` — add the 2 worker entry trees.
- `bunfig.toml` — no change (preloads passed via `--preload`, not the test-runner default).
- `.github/workflows/_test-suite.yml` — add `--preload`s + the merge step to the Linux + macOS/Windows coverage runs.
- `package.json` — pinned dev deps + a `coverage:merge` script.
- `docs/structure-audit/coverage-baseline.json` — regenerate as v2 (Task 10).

---

## Task 0: Install pinned dev dependencies

**Files:**
- Modify: `package.json` (devDependencies)

- [ ] **Step 1: Run the dependency-safety pre-flight mindset, then add the deps (dev-only, exact-pinned)**

Run:
```bash
bun add -d -E @babel/core @babel/preset-typescript babel-plugin-istanbul istanbul-lib-coverage istanbul-lib-report istanbul-reports @types/babel__core @types/istanbul-lib-coverage @types/istanbul-lib-report @types/istanbul-reports
```
`-E` pins exact versions. These are dev-only (never shipped). The `@types/*` packages are required because the repo bans `any` (CLAUDE.md non-negotiable #7) and `istanbul-lib-*` ship no types. If `bun add` rewrites unrelated `overrides`, revert those hunks.

- [ ] **Step 2: Verify they resolved and typecheck still passes**

Run: `bun run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build(coverage): add pinned dev deps for istanbul branch instrumentation"
```

---

## Task 1: Parse BRDA branch coverage in `lcov-parse.ts`

**Files:**
- Modify: `scripts/coverage-floor/lcov-parse.ts`
- Test: `scripts/coverage-floor/lcov-parse.test.ts`

- [ ] **Step 1: Update existing tests + add branch tests (write them first, they will fail)**

Replace the whole body of `scripts/coverage-floor/lcov-parse.test.ts` with:

```ts
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
    const lcov = ["TN:", "SF:packages/gateway/src/foo.ts", "DA:1,1", "DA:2,1", "DA:3,1", "end_of_record", ""].join("\n");
    const rec = parseLcov(lcov).get("packages/gateway/src/foo.ts");
    expect(rec).toEqual({ lines: 3, covered: 3, pct: 100, branches: 0, branchesHit: 0, branchPct: 100 });
  });

  test("computes line percent to 2 decimals", () => {
    const lcov = ["SF:packages/gateway/src/bar.ts", "DA:1,5", "DA:2,0", "DA:3,3", "DA:4,0", "DA:5,1", "DA:6,0", "DA:7,0", "end_of_record"].join("\n");
    const rec = parseLcov(lcov).get("packages/gateway/src/bar.ts");
    expect(rec).toEqual({ lines: 7, covered: 3, pct: 42.86, branches: 0, branchesHit: 0, branchPct: 100 });
  });

  test("treats a record with zero DA lines as 100% line and 100% branch", () => {
    const rec = parseLcov("SF:packages/gateway/src/types/empty.ts\nend_of_record\n").get("packages/gateway/src/types/empty.ts");
    expect(rec).toEqual({ lines: 0, covered: 0, pct: 100, branches: 0, branchesHit: 0, branchPct: 100 });
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
    expect(rec).toEqual({ lines: 2, covered: 1, pct: 50, branches: 3, branchesHit: 1, branchPct: 33.33 });
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
    const lcov = ["SF:a.ts", "DA:1,0", "BRDA:1,0,0,-", "end_of_record", "SF:a.ts", "DA:1,1", "BRDA:1,0,0,1", "end_of_record"].join("\n");
    const rec = parseLcov(lcov).get("a.ts");
    expect(rec).toEqual({ lines: 1, covered: 1, pct: 100, branches: 1, branchesHit: 1, branchPct: 100 });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test scripts/coverage-floor/lcov-parse.test.ts`
Expected: FAIL — the `toEqual` objects don't yet contain `branches`/`branchesHit`/`branchPct`.

- [ ] **Step 3: Implement BRDA parsing**

Replace the whole `scripts/coverage-floor/lcov-parse.ts` with:

```ts
export interface FileCoverage {
  readonly lines: number;
  readonly covered: number;
  readonly pct: number;
  readonly branches: number;
  readonly branchesHit: number;
  readonly branchPct: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseLcov(text: string): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  let currentFile: string | null = null;
  let lines = 0;
  let covered = 0;
  let branches = 0;
  let branchesHit = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).replaceAll("\\", "/");
      lines = 0;
      covered = 0;
      branches = 0;
      branchesHit = 0;
      continue;
    }
    if (line.startsWith("DA:") && currentFile !== null) {
      const comma = line.indexOf(",");
      if (comma === -1) continue;
      lines += 1;
      const hit = Number.parseInt(line.slice(comma + 1), 10);
      if (Number.isFinite(hit) && hit > 0) covered += 1;
      continue;
    }
    if (line.startsWith("BRDA:") && currentFile !== null) {
      const taken = line.slice(line.lastIndexOf(",") + 1);
      branches += 1;
      if (taken !== "-") {
        const n = Number.parseInt(taken, 10);
        if (Number.isFinite(n) && n > 0) branchesHit += 1;
      }
      continue;
    }
    if (line === "end_of_record" && currentFile !== null) {
      const pct = lines === 0 ? 100 : round2((100 * covered) / lines);
      const branchPct = branches === 0 ? 100 : round2((100 * branchesHit) / branches);
      out.set(currentFile, { lines, covered, pct, branches, branchesHit, branchPct });
      currentFile = null;
      lines = 0;
      covered = 0;
      branches = 0;
      branchesHit = 0;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `bun test scripts/coverage-floor/lcov-parse.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/lcov-parse.ts scripts/coverage-floor/lcov-parse.test.ts
git commit -m "feat(coverage): parse BRDA branch records into branchPct"
```

---

## Task 2: v2 baseline schema + v1→v2 read shim + dual-axis diff

**Files:**
- Modify: `scripts/coverage-floor/baseline.ts`
- Test: `scripts/coverage-floor/baseline.test.ts`

- [ ] **Step 1: Write the new tests first (they will fail)**

Replace the whole `scripts/coverage-floor/baseline.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";

import { type Baseline, computeBaselineDiff, parseBaseline, serializeBaseline } from "./baseline.ts";

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
    expect(() => parseBaseline(JSON.stringify({ version: 3, generated_at: "x", files: {} }))).toThrow(/version/);
  });

  test("throws on missing generated_at", () => {
    expect(() => parseBaseline(JSON.stringify({ version: 2, files: {} }))).toThrow(/generated_at/);
  });

  test("throws on a min_branch_pct outside 0..100", () => {
    const json = JSON.stringify({ version: 2, generated_at: "x", files: { "a.ts": { min_line_pct: 50, min_branch_pct: 101 } } });
    expect(() => parseBaseline(json)).toThrow(/min_branch_pct/);
  });

  test("rejects backslash-separated paths", () => {
    const json = JSON.stringify({ version: 2, generated_at: "x", files: { "packages\\gateway\\src\\foo.ts": { min_line_pct: 50, min_branch_pct: 0 } } });
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
      files: new Map([["z.ts", { line: 1, branch: 1 }], ["a.ts", { line: 2, branch: 2 }]]),
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
    const diff = computeBaselineDiff(base(50, 40), new Map([["a.ts", 50]]), new Map([["a.ts", 40]]));
    expect(diff).toEqual({ regressions: [], mustRaise: [], mustRemove: [], missingFromActual: [] });
  });

  test("flags a line regression", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map([["a.ts", 45]]), new Map([["a.ts", 40]]));
    expect(diff.regressions).toEqual([{ path: "a.ts", dimension: "line", baseline: 50, actual: 45 }]);
  });

  test("flags a branch regression", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map([["a.ts", 50]]), new Map([["a.ts", 30]]));
    expect(diff.regressions).toEqual([{ path: "a.ts", dimension: "branch", baseline: 40, actual: 30 }]);
  });

  test("flags must-remove only when BOTH axes clear the floor (>=80)", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map([["a.ts", 81]]), new Map([["a.ts", 85]]));
    expect(diff.mustRemove).toEqual([{ path: "a.ts" }]);
    expect(diff.mustRaise).toEqual([]);
  });

  test("flags must-raise (not remove) when only one axis improves and the other is still below floor", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map([["a.ts", 90]]), new Map([["a.ts", 55]]));
    expect(diff.mustRemove).toEqual([]);
    expect(diff.mustRaise).toEqual([{ path: "a.ts" }]);
  });

  test("a baseline file missing from both actual maps is a 0% regression", () => {
    const diff = computeBaselineDiff(base(50, 40), new Map(), new Map());
    expect(diff.regressions).toEqual([{ path: "a.ts", dimension: "line", baseline: 50, actual: 0 }, { path: "a.ts", dimension: "branch", baseline: 40, actual: 0 }]);
    expect(diff.missingFromActual).toEqual(["a.ts"]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test scripts/coverage-floor/baseline.test.ts`
Expected: FAIL — `parseBaseline` rejects version 2, types/shape differ.

- [ ] **Step 3: Rewrite `scripts/coverage-floor/baseline.ts`**

Replace the whole file with:

```ts
export interface FileFloor {
  readonly line: number;
  readonly branch: number;
}

export interface Baseline {
  readonly version: 2;
  readonly generated_at: string;
  readonly files: Map<string, FileFloor>;
}

export interface BaselineDiff {
  readonly regressions: ReadonlyArray<{
    path: string;
    dimension: "line" | "branch";
    baseline: number;
    actual: number;
  }>;
  readonly mustRaise: ReadonlyArray<{ path: string }>;
  readonly mustRemove: ReadonlyArray<{ path: string }>;
  readonly missingFromActual: ReadonlyArray<string>;
}

export const FLOOR_PCT = 80; // line floor
export const BRANCH_FLOOR_PCT = 80; // branch floor (separate constant so it can diverge)

function assertPct(label: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`baseline entry ${label}: must be a number in [0, 100]`);
  }
  return v;
}

export function parseBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("baseline JSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj["version"];
  if (version !== 1 && version !== 2) {
    throw new Error(`baseline version must be 1 or 2 (got ${JSON.stringify(version)})`);
  }
  if (typeof obj["generated_at"] !== "string") {
    throw new TypeError("baseline generated_at must be an ISO-8601 string");
  }
  const filesRaw = obj["files"];
  if (filesRaw === null || typeof filesRaw !== "object" || Array.isArray(filesRaw)) {
    throw new Error("baseline files must be an object");
  }
  const files = new Map<string, FileFloor>();
  for (const [path, entry] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (path.includes("\\")) {
      throw new Error(
        `baseline entry contains backslash separator: ${JSON.stringify(path)} — use forward slashes (e.g. "packages/gateway/src/foo.ts")`,
      );
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`baseline entry ${path}: must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (version === 1) {
      // v1 -> v2 read shim: branch floor starts at 0 (ratchet-from-zero).
      files.set(path, { line: assertPct(`${path}.min_coverage_pct`, e["min_coverage_pct"]), branch: 0 });
    } else {
      files.set(path, {
        line: assertPct(`${path}.min_line_pct`, e["min_line_pct"]),
        branch: assertPct(`${path}.min_branch_pct`, e["min_branch_pct"]),
      });
    }
  }
  return { version: 2, generated_at: obj["generated_at"], files };
}

export function serializeBaseline(b: Baseline): string {
  const sortedKeys = Array.from(b.files.keys()).sort((a, b) => (a > b ? 1 : -1));
  const files: Record<string, { min_line_pct: number; min_branch_pct: number }> = {};
  for (const k of sortedKeys) {
    const v = b.files.get(k);
    if (v !== undefined) files[k] = { min_line_pct: v.line, min_branch_pct: v.branch };
  }
  return `${JSON.stringify({ version: 2, generated_at: b.generated_at, files }, null, 2)}\n`;
}

export function computeBaselineDiff(
  baseline: Baseline,
  actualLine: ReadonlyMap<string, number>,
  actualBranch: ReadonlyMap<string, number>,
): BaselineDiff {
  const regressions: Array<{ path: string; dimension: "line" | "branch"; baseline: number; actual: number }> = [];
  const mustRaise: Array<{ path: string }> = [];
  const mustRemove: Array<{ path: string }> = [];
  const missingFromActual: string[] = [];
  for (const [path, floor] of baseline.files) {
    const present = actualLine.has(path) || actualBranch.has(path);
    const lineActual = actualLine.get(path) ?? 0;
    const branchActual = actualBranch.get(path) ?? 0;
    if (!present) missingFromActual.push(path);
    let regressed = false;
    if (lineActual < floor.line) {
      regressions.push({ path, dimension: "line", baseline: floor.line, actual: lineActual });
      regressed = true;
    }
    if (branchActual < floor.branch) {
      regressions.push({ path, dimension: "branch", baseline: floor.branch, actual: branchActual });
      regressed = true;
    }
    if (regressed) continue;
    const fullySatisfied = lineActual >= FLOOR_PCT && branchActual >= BRANCH_FLOOR_PCT;
    if (fullySatisfied) {
      mustRemove.push({ path });
    } else if (lineActual > floor.line || branchActual > floor.branch) {
      mustRaise.push({ path });
    }
  }
  return { regressions, mustRaise, mustRemove, missingFromActual };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test scripts/coverage-floor/baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/baseline.ts scripts/coverage-floor/baseline.test.ts
git commit -m "feat(coverage): v2 line+branch baseline schema with v1 read shim"
```

---

## Task 3: Dual-axis `check.ts` (evaluate + update + dimension-tagged output)

**Files:**
- Modify: `scripts/coverage-floor/check.ts`
- Test: `scripts/coverage-floor/check.test.ts` (create if absent)

> Note: `check.ts` reads `COVERAGE_LCOV_PATH` (default `coverage/lcov.info`). `discoverSourceFiles()` and `isExempt()` are unchanged and reused.

- [ ] **Step 1: Write the evaluate tests first**

Create `scripts/coverage-floor/check.test.ts`:

```ts
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
    expect(r.violations).toContainEqual({ kind: "below_floor", dimension: "branch", path: "packages/gateway/src/a.ts", actual: 60 });
  });

  test("flags missing_from_lcov when a non-baselined source file has no line data", () => {
    const r = evaluateCheck({
      sourceFiles: ["packages/gateway/src/a.ts"],
      actualLine: new Map(),
      actualBranch: new Map(),
      baseline: emptyBaseline,
    });
    expect(r.violations).toContainEqual({ kind: "missing_from_lcov", path: "packages/gateway/src/a.ts" });
  });

  test("skips the floor check for a baselined file but applies the ratchet", () => {
    const baseline: Baseline = { version: 2, generated_at: "x", files: new Map([["packages/gateway/src/a.ts", { line: 78, branch: 40 }]]) };
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
      { version: 2, generated_at: "x", files: new Map([["packages/gateway/src/a.ts", { line: 78, branch: 40 }]]) },
      new Map([["packages/gateway/src/a.ts", 85]]),
      new Map([["packages/gateway/src/a.ts", 82]]),
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.has("packages/gateway/src/a.ts")).toBe(false);
  });

  test("ratchets an unsatisfied axis up to its actual but never down", () => {
    const next = computeUpdatedBaseline(
      { version: 2, generated_at: "x", files: new Map([["packages/gateway/src/a.ts", { line: 50, branch: 30 }]]) },
      new Map([["packages/gateway/src/a.ts", 60]]),
      new Map([["packages/gateway/src/a.ts", 20]]), // dropped below stored — keep the higher watermark
      ["packages/gateway/src/a.ts"],
      "now",
    );
    expect(next.files.get("packages/gateway/src/a.ts")).toEqual({ line: 60, branch: 30 });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test scripts/coverage-floor/check.test.ts`
Expected: FAIL — `evaluateCheck`/`computeUpdatedBaseline` have the old single-axis shape.

- [ ] **Step 3: Rewrite the relevant parts of `check.ts`**

In `scripts/coverage-floor/check.ts`:

(a) Update imports from `./baseline.ts` to include both floors + the new diff shape:

```ts
import {
  type Baseline,
  type BaselineDiff,
  BRANCH_FLOOR_PCT,
  computeBaselineDiff,
  FLOOR_PCT,
  parseBaseline,
  serializeBaseline,
} from "./baseline.ts";
```

(b) Replace the `EvaluateInput`, `Violation`, `EvaluateResult`, `evaluateCheck`, and `computeUpdatedBaseline` declarations with:

```ts
export interface EvaluateInput {
  readonly sourceFiles: ReadonlyArray<string>;
  readonly actualLine: ReadonlyMap<string, number>;
  readonly actualBranch: ReadonlyMap<string, number>;
  readonly baseline: Baseline;
}

export type Violation =
  | { kind: "below_floor"; dimension: "line" | "branch"; path: string; actual: number }
  | { kind: "missing_from_lcov"; path: string }
  | { kind: "regression"; dimension: "line" | "branch"; path: string; baseline: number; actual: number }
  | { kind: "must_raise"; path: string }
  | { kind: "must_remove"; path: string };

export interface EvaluateResult {
  readonly exitCode: 0 | 1;
  readonly violations: ReadonlyArray<Violation>;
  readonly diff: BaselineDiff;
}

export function evaluateCheck(input: EvaluateInput): EvaluateResult {
  const violations: Violation[] = [];
  for (const path of input.sourceFiles) {
    if (isExempt(path)) continue;
    if (input.baseline.files.has(path)) continue;
    const line = input.actualLine.get(path);
    if (line === undefined) {
      violations.push({ kind: "missing_from_lcov", path });
      continue;
    }
    if (line < FLOOR_PCT) violations.push({ kind: "below_floor", dimension: "line", path, actual: line });
    const branch = input.actualBranch.get(path) ?? 100;
    if (branch < BRANCH_FLOOR_PCT) violations.push({ kind: "below_floor", dimension: "branch", path, actual: branch });
  }
  const diff = computeBaselineDiff(input.baseline, input.actualLine, input.actualBranch);
  for (const r of diff.regressions) {
    violations.push({ kind: "regression", dimension: r.dimension, path: r.path, baseline: r.baseline, actual: r.actual });
  }
  for (const m of diff.mustRaise) violations.push({ kind: "must_raise", path: m.path });
  for (const m of diff.mustRemove) violations.push({ kind: "must_remove", path: m.path });
  return { exitCode: violations.length === 0 ? 0 : 1, violations, diff };
}

export function computeUpdatedBaseline(
  baseline: Baseline,
  actualLine: ReadonlyMap<string, number>,
  actualBranch: ReadonlyMap<string, number>,
  sourceFiles: ReadonlyArray<string>,
  generatedAt: string,
): Baseline {
  const next = new Map<string, { line: number; branch: number }>();
  const consider = (path: string): void => {
    if (next.has(path)) return;
    const existing = baseline.files.get(path);
    const line = actualLine.get(path) ?? 0;
    const branch = actualBranch.get(path) ?? 0;
    if (line >= FLOOR_PCT && branch >= BRANCH_FLOOR_PCT) return; // fully clear -> drop
    const storeLine = line >= FLOOR_PCT ? FLOOR_PCT : Math.max(existing?.line ?? 0, line);
    const storeBranch = branch >= BRANCH_FLOOR_PCT ? BRANCH_FLOOR_PCT : Math.max(existing?.branch ?? 0, branch);
    next.set(path, { line: storeLine, branch: storeBranch });
  };
  for (const path of baseline.files.keys()) consider(path);
  for (const path of sourceFiles) {
    if (isExempt(path)) continue;
    consider(path);
  }
  return { version: 2, generated_at: generatedAt, files: next };
}
```

(c) Replace `lcovToPctMap` with two extractors and update `main()` to build both maps and pass them through. Find the existing `lcovToPctMap` helper and `main()`; replace the helper with:

```ts
function lcovToLinePctMap(map: ReturnType<typeof parseLcov>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, fc] of map) out.set(path, fc.pct);
  return out;
}

function lcovToBranchPctMap(map: ReturnType<typeof parseLcov>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, fc] of map) out.set(path, fc.branchPct);
  return out;
}
```

In `main()`, replace the single `const actual = lcovToPctMap(parseLcov(lcovText));` and the `evaluateCheck`/`computeUpdatedBaseline` calls with:

```ts
const parsed = parseLcov(lcovText);
const actualLine = lcovToLinePctMap(parsed);
const actualBranch = lcovToBranchPctMap(parsed);
// ... baseline + sourceFiles loaded as before ...
if (updateMode) {
  const next = computeUpdatedBaseline(baseline, actualLine, actualBranch, sourceFiles, new Date().toISOString());
  await Bun.write(absBaseline, serializeBaseline(next));
  console.log(`coverage-floor: updated baseline at ${baselinePath} (${next.files.size} entries; was ${baseline.files.size})`);
  return;
}
const result = evaluateCheck({ sourceFiles, actualLine, actualBranch, baseline });
```

(d) Replace `printViolations` with a dimension-aware version:

```ts
function printViolations(violations: ReadonlyArray<Violation>): void {
  for (const v of violations) {
    switch (v.kind) {
      case "below_floor":
        console.error(`::error file=${v.path}::${v.dimension} coverage ${v.actual}% < ${v.dimension === "line" ? FLOOR_PCT : BRANCH_FLOOR_PCT}% floor`);
        break;
      case "missing_from_lcov":
        console.error(`::error file=${v.path}::file has no coverage data in lcov (treated as 0%); add a test or add to the baseline`);
        break;
      case "regression":
        console.error(`::error file=${v.path}::${v.dimension} coverage regressed from ${v.baseline}% to ${v.actual}%`);
        break;
      case "must_raise":
        console.error(`::error file=${v.path}::coverage improved above its baseline watermark — run: bun run audit:coverage-floor:update-baseline`);
        break;
      case "must_remove":
        console.error(`::error file=${v.path}::coverage now clears both floors — remove the baseline entry: bun run audit:coverage-floor:update-baseline`);
        break;
    }
  }
}
```

- [ ] **Step 4: Run the unit tests + typecheck**

Run: `bun test scripts/coverage-floor/check.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/check.ts scripts/coverage-floor/check.test.ts
git commit -m "feat(coverage): dual line+branch floor gate in check.ts"
```

---

## Task 4: Istanbul instrumentation preload + scope predicate

**Files:**
- Create: `scripts/coverage/instrument-scope.ts`, `scripts/coverage/instrument-scope.test.ts`, `scripts/coverage/istanbul-register.ts`
- Create (fixture): `scripts/coverage/__fixtures__/sample/m.ts`, `.../m.test.ts`

- [ ] **Step 1: Write the scope-predicate test**

Create `scripts/coverage/instrument-scope.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { shouldInstrument } from "./instrument-scope.ts";

describe("shouldInstrument", () => {
  test("instruments first-party package src", () => {
    expect(shouldInstrument("/repo/packages/gateway/src/engine/executor.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/cli/src/index.ts")).toBe(true);
    expect(shouldInstrument("/repo/packages/mcp-connectors/jira/src/tools.ts")).toBe(true);
  });
  test("skips node_modules, test/spec files, and non-src", () => {
    expect(shouldInstrument("/repo/node_modules/@babel/core/lib/index.js")).toBe(false);
    expect(shouldInstrument("/repo/packages/gateway/src/engine/executor.test.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/gateway/src/engine/foo.spec.ts")).toBe(false);
    expect(shouldInstrument("/repo/scripts/coverage/merge-coverage.ts")).toBe(false);
    expect(shouldInstrument("/repo/packages/ui/src/App.tsx")).toBe(false);
  });
  test("normalizes Windows backslashes", () => {
    expect(shouldInstrument(String.raw`C:\repo\packages\gateway\src\a.ts`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test scripts/coverage/instrument-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the predicate**

Create `scripts/coverage/instrument-scope.ts`:

```ts
// Decides whether the istanbul preload should instrument a given module.
// Scope-gate to FIRST-PARTY package src only — a broad filter lets Babel's own
// node_modules re-enter the onLoad hook and crashes Babel internals.
const FIRST_PARTY = /\/packages\/(?:gateway|cli|sdk|client)\/src\//;
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/[^/]+\/src\//;

export function shouldInstrument(absPath: string): boolean {
  const p = absPath.replaceAll("\\", "/");
  if (p.includes("/node_modules/")) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return false;
  return FIRST_PARTY.test(p) || CONNECTOR_SRC.test(p);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun test scripts/coverage/instrument-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the instrumentation preload**

Create `scripts/coverage/istanbul-register.ts`:

```ts
// Bun [test].preload — instruments first-party src TS/TSX on load with
// babel-plugin-istanbul so `bun test` accrues line+branch coverage on
// globalThis.__coverage__. Validated recipe (design spec §2):
//   Babel preset-typescript + babel-plugin-istanbul + retainLines (line
//   fidelity) + inline source maps (stack traces). Preset/plugin are passed as
//   FUNCTION REFERENCES (string names crash under Bun's ESM interop), and only
//   first-party src is transformed (a broad filter crashes Babel internals).
import { transformSync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import babelPluginIstanbul from "babel-plugin-istanbul";
import { readFileSync } from "node:fs";
import { plugin } from "bun";

import { shouldInstrument } from "./instrument-scope.ts";

plugin({
  name: "istanbul-instrument",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
      const isTsx = args.path.endsWith(".tsx");
      const source = readFileSync(args.path, "utf8");
      // onLoad MUST always return an object (returning undefined aborts the run).
      if (!shouldInstrument(args.path)) {
        return { contents: source, loader: isTsx ? "tsx" : "ts" };
      }
      const result = transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        retainLines: true,
        sourceMaps: "inline",
        presets: [[presetTypescript, { allExtensions: true, isTSX: isTsx, allowDeclareFields: true }]],
        plugins: [[babelPluginIstanbul, {}]],
      });
      const code = result?.code ?? source;
      // Instrumented output is plain JS(X); JSX must keep the jsx loader.
      return { contents: code, loader: isTsx ? "jsx" : "js" };
    });
  },
});
```

- [ ] **Step 6: Create the verification fixture**

Create `scripts/coverage/__fixtures__/sample/m.ts`:

```ts
export function classify(n: number): string {
  if (n < 0) {
    return "negative";
  }
  const parity = n % 2 === 0 ? "even" : "odd";
  return n > 100 && parity === "even" ? "big-even" : parity;
}
```

Create `scripts/coverage/__fixtures__/sample/m.test.ts`:

```ts
import { expect, test } from "bun:test";

import { classify } from "./m.ts";

test("classify covers some but not all branches", () => {
  expect(classify(4)).toBe("even"); // leaves the n<0 and n>100 branches unexercised
});
```

Add the fixture dir to the scope predicate's first-party match for the verification run by pointing the preload at it through an env override is unnecessary — instead, the verification step below runs the fixture with a tiny inline scope. To keep `shouldInstrument` production-focused, the fixture is instrumented via a one-off `--preload` whose filter includes the fixture path. Create `scripts/coverage/__fixtures__/preload-fixture.ts`:

```ts
import { afterAll } from "bun:test";
import { transformSync } from "@babel/core";
import presetTypescript from "@babel/preset-typescript";
import babelPluginIstanbul from "babel-plugin-istanbul";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { plugin } from "bun";

plugin({
  name: "fixture-instrument",
  setup(build) {
    build.onLoad({ filter: /__fixtures__[/\\]sample[/\\]m\.ts$/ }, (args) => {
      const result = transformSync(readFileSync(args.path, "utf8"), {
        filename: args.path,
        babelrc: false,
        configFile: false,
        retainLines: true,
        presets: [[presetTypescript, { allExtensions: true }]],
        plugins: [[babelPluginIstanbul, {}]],
      });
      return { contents: result?.code ?? "", loader: "js" };
    });
  },
});

afterAll(() => {
  const cov = (globalThis as { __coverage__?: unknown }).__coverage__;
  mkdirSync("coverage/.fixture", { recursive: true });
  writeFileSync("coverage/.fixture/cov.json", JSON.stringify(cov ?? {}));
});
```

- [ ] **Step 7: Verify the preload produces branch data (the linchpin check)**

Run:
```bash
bun test --preload ./scripts/coverage/__fixtures__/preload-fixture.ts scripts/coverage/__fixtures__/sample/m.test.ts
bun -e "const c=require('./coverage/.fixture/cov.json'); const f=Object.values(c)[0]; console.log('branches:', Object.keys(f.b).length, 'hit-vectors:', JSON.stringify(Object.values(f.b)));"
```
Expected: the printed coverage has a non-empty `b` (branch) map with at least one all-zero hit vector (the unexercised `n<0` / `n>100` branches). If `b` is empty, the instrumentation is broken — STOP and debug the preload before continuing.

- [ ] **Step 8: Commit**

```bash
git add scripts/coverage/instrument-scope.ts scripts/coverage/instrument-scope.test.ts scripts/coverage/istanbul-register.ts scripts/coverage/__fixtures__
git commit -m "feat(coverage): istanbul instrumentation preload + scope predicate"
```

---

## Task 5: Coverage flush preload (`report-coverage.ts`)

**Files:**
- Create: `scripts/coverage/report-coverage.ts`

- [ ] **Step 1: Implement the flush preload**

Create `scripts/coverage/report-coverage.ts`:

```ts
// Bun [test].preload — after all tests in a `bun test` invocation, dump the raw
// istanbul coverage map to a per-process JSON shard. A separate merge step
// (merge-coverage.ts) unions all shards into one lcov. Per-process file is
// overwrite-idempotent, so this is correct whether afterAll fires once or
// per-file and whether Bun runs one process or many (design spec §5.2.1).
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TMP_DIR = resolve(REPO_ROOT, "coverage", ".nyc-tmp");

afterAll(() => {
  const cov = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__;
  if (cov === undefined || Object.keys(cov).length === 0) return;
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(resolve(TMP_DIR, `${process.pid}.json`), JSON.stringify(cov));
});
```

- [ ] **Step 2: Smoke-test it produces a shard**

Run:
```bash
rm -rf coverage/.nyc-tmp
bun test --preload ./scripts/coverage/istanbul-register.ts --preload ./scripts/coverage/report-coverage.ts scripts/coverage-floor/lcov-parse.test.ts
ls coverage/.nyc-tmp
```
Expected: at least one `<pid>.json` file exists. (The instrumented modules here are the `scripts/coverage-floor/*` sources imported by the test — note `scripts/` is not first-party `src`, so `__coverage__` may be empty and no shard is written; that's fine for the smoke test. To force a shard, temporarily run a gateway test: `bun test --preload ./scripts/coverage/istanbul-register.ts --preload ./scripts/coverage/report-coverage.ts packages/gateway/src/engine/tool-output-envelope.test.ts` and confirm a shard appears.)

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage/report-coverage.ts
git commit -m "feat(coverage): per-process coverage flush preload"
```

---

## Task 6: Merge shards into `coverage/lcov.info`

**Files:**
- Create: `scripts/coverage/merge-coverage.ts`, `scripts/coverage/merge-coverage.test.ts`
- Modify: `package.json` (add `coverage:merge` script)

- [ ] **Step 1: Write the merge test**

Create `scripts/coverage/merge-coverage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeShardsToLcov } from "./merge-coverage.ts";

// A minimal istanbul fileCoverage for an absolute file with one covered line
// and one branch (one outcome taken, one not).
function fc(absPath: string) {
  return {
    path: absPath,
    statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } } },
    s: { "0": 1 },
    fnMap: {},
    f: {},
    branchMap: { "0": { type: "if", line: 1, locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }, { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }] } },
    b: { "0": [1, 0] },
  };
}

describe("mergeShardsToLcov", () => {
  test("merges shards and writes a repo-root-relative lcov with BRDA", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "cov-merge-"));
    const tmp = join(repoRoot, "coverage", ".nyc-tmp");
    mkdirSync(tmp, { recursive: true });
    const abs = join(repoRoot, "packages", "gateway", "src", "a.ts");
    writeFileSync(join(tmp, "111.json"), JSON.stringify({ [abs]: fc(abs) }));

    mergeShardsToLcov(repoRoot);

    const out = join(repoRoot, "coverage", "lcov.info");
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("SF:packages/gateway/src/a.ts");
    expect(text).toContain("BRDA:");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test scripts/coverage/merge-coverage.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the merge**

Create `scripts/coverage/merge-coverage.ts`:

```ts
#!/usr/bin/env bun
// Merge per-process istanbul coverage shards (coverage/.nyc-tmp/*.json) into a
// single coverage/lcov.info with repo-root-relative SF paths. Runs once after
// all per-package `bun test` invocations (design spec §5.2.1).
import { Glob } from "bun";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import libCoverage, { type CoverageMapData, type FileCoverageData } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";

export function mergeShardsToLcov(repoRoot: string): number {
  const tmpDir = resolve(repoRoot, "coverage", ".nyc-tmp");
  const merged = libCoverage.createCoverageMap({});
  let shards = 0;
  if (existsSync(tmpDir)) {
    for (const file of new Glob("*.json").scanSync({ cwd: tmpDir, absolute: true })) {
      merged.merge(JSON.parse(readFileSync(file, "utf8")) as CoverageMapData);
      shards += 1;
    }
  }
  // Re-key absolute paths to repo-root-relative + forward slashes.
  const rel = libCoverage.createCoverageMap({});
  for (const absFile of merged.files()) {
    const data = merged.fileCoverageFor(absFile).data;
    const relPath = relative(repoRoot, absFile).replaceAll("\\", "/");
    rel.addFileCoverage({ ...data, path: relPath } as FileCoverageData);
  }
  const context = createContext({ dir: resolve(repoRoot, "coverage"), coverageMap: rel });
  reports.create("lcovonly", {}).execute(context);
  // Delete shards after merging so a later standalone merge can't pick up stale
  // data from an aborted/direct run (plan review #1). Orchestrators also
  // `rm -rf coverage` before each run for a clean shard dir.
  rmSync(tmpDir, { recursive: true, force: true });
  return shards;
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const shards = mergeShardsToLcov(repoRoot);
  console.log(`merge-coverage: merged ${shards} shard(s) -> coverage/lcov.info`);
}
```

- [ ] **Step 4: Run to confirm pass + add the script**

Run: `bun test scripts/coverage/merge-coverage.test.ts`
Expected: PASS.

Add to `package.json` `scripts` (next to the other `audit:coverage-floor*` entries):

```json
"coverage:merge": "bun scripts/coverage/merge-coverage.ts",
```

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage/merge-coverage.ts scripts/coverage/merge-coverage.test.ts package.json
git commit -m "feat(coverage): merge istanbul shards into branch-aware lcov"
```

---

## Task 7: Wire the local `build-lcov.sh` end-to-end

**Files:**
- Modify: `scripts/coverage-floor/build-lcov.sh`

- [ ] **Step 1: Switch the per-package run to the instrumented preloads + merge**

Replace the body of `build-lcov.sh` from the `rm -rf coverage` line through the final echo with:

```bash
set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}" || exit 1

rm -rf coverage
mkdir -p coverage/.nyc-tmp

REGISTER="${REPO_ROOT}/scripts/coverage/istanbul-register.ts"
REPORT="${REPO_ROOT}/scripts/coverage/report-coverage.ts"

run_pkg () {
  local pkg="$1"
  if [[ -z "$(find "${pkg}" -path "${pkg}/node_modules" -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print -quit)" ]]; then
    echo "Skipping ${pkg} — no test files."
    return 0
  fi
  echo "=== ${pkg} ==="
  (
    cd "${pkg}"
    bun test --preload "${REGISTER}" --preload "${REPORT}"
  ) || true  # tolerate failing tests; whatever coverage was collected still merges
}

for pkg in packages/gateway packages/cli packages/sdk packages/client; do
  run_pkg "${pkg}"
done

for pkg in packages/mcp-connectors/*; do
  if [[ -f "${pkg}/package.json" ]]; then
    run_pkg "${pkg}"
  fi
done

bun "${REPO_ROOT}/scripts/coverage/merge-coverage.ts"

echo "---"
echo "coverage/lcov.info: $(wc -l < coverage/lcov.info) lines, $(grep -c '^SF:' coverage/lcov.info) source files, $(grep -c '^BRDA:' coverage/lcov.info) branch records"
```

- [ ] **Step 2: Run the full local build + confirm branch records exist**

Run: `bun run audit:coverage-floor:build-lcov`
Expected: completes; the final line shows a **non-zero** `BRDA:` count. (This is the Windows-local approximation; the authoritative numbers come from CI-Linux in Task 10.)

If `BRDA:` count is 0: the preloads aren't instrumenting — re-check Task 4 Step 7 and that the `--preload` paths are absolute.

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage-floor/build-lcov.sh
git commit -m "build(coverage): drive build-lcov via istanbul preloads + merge"
```

---

## Task 8: Wire the CI coverage job (`_test-suite.yml`)

**Files:**
- Modify: `.github/workflows/_test-suite.yml`

- [ ] **Step 1: Linux per-package run — swap to preloads**

In the **"Unit tests (with coverage) — Linux"** step's `run_pkg` (around lines 196–211), replace the `bun test` invocation and the per-package `sed` rewrite. Change the inner run from the native-coverage form to:

```bash
            echo "::group::Tests + coverage — ${pkg}"
            (
              cd "${pkg}"
              bash "${GITHUB_WORKSPACE}/scripts/ci/run-with-optional-dbus.sh" \
                bun test \
                --preload "${GITHUB_WORKSPACE}/scripts/coverage/istanbul-register.ts" \
                --preload "${GITHUB_WORKSPACE}/scripts/coverage/report-coverage.ts" \
                --reporter=junit \
                --reporter-outfile="${GITHUB_WORKSPACE}/junit-reports/junit-unit-${safe_name}.xml"
            )
            echo "::endgroup::"
```

Remove the per-package `if [ -f "${pkg}/coverage/lcov.info" ]; then sed ... >> coverage/lcov.info; fi` block (the merge step now produces the lcov). **Keep the existing `rm -rf coverage` line** (line ~181) — it guarantees a clean shard dir each CI run (plan review #1). Change `mkdir -p coverage junit-reports` to also make the shard dir: `mkdir -p coverage/.nyc-tmp junit-reports`. Remove the `: > coverage/lcov.info` line (merge writes it).

- [ ] **Step 2: Add the merge step after the package loops**

Immediately after the `run_pkg "packages/mcp-connectors/shared"` line (and before the `bun test scripts ...` block), add:

```bash
          bun "${GITHUB_WORKSPACE}/scripts/coverage/merge-coverage.ts"
```

- [ ] **Step 3: macOS/Windows run — add preloads (no merge needed for the gate)**

In the **"Unit tests (with coverage) — macOS/Windows (retry once)"** step, change the `bun test ... --coverage --coverage-reporter=lcov ...` line to use the preloads instead (these OSes don't run the floor gate, but keeping them instrumented avoids a divergent test path):

```bash
            bun test packages/gateway packages/cli packages/sdk packages/client packages/mcp-connectors scripts --preload "${GITHUB_WORKSPACE}/scripts/coverage/istanbul-register.ts" --preload "${GITHUB_WORKSPACE}/scripts/coverage/report-coverage.ts" --reporter=junit --reporter-outfile=junit-reports/junit-unit.xml
```

> Leave the per-subsystem `test:coverage:engine|vault|embedding|…` scripts (which use Bun-native `--coverage-threshold-lines`) untouched — they are independent line-only gates and must keep working.

- [ ] **Step 4: Validate the workflow YAML (best-effort; CI is authoritative)**

The push in Task 10 is the authoritative YAML validator (GitHub rejects/serially-errors a malformed workflow). Do **not** add a dependency just to check locally. Optionally, if `yaml` already resolves in the repo (it's a common transitive dep), do a quick parse:
```bash
bun -e "import('yaml').then(async m => { m.parse(await Bun.file('.github/workflows/_test-suite.yml').text()); console.log('yaml ok'); }).catch(e => console.log('skip local check:', e.message))"
```
Expected: `yaml ok`, or `skip local check: ...` if `yaml` isn't installed (fine — rely on CI). Either way, re-read your diff by eye for indentation before pushing.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/_test-suite.yml
git commit -m "ci(coverage): instrument the Linux coverage job for branch data"
```

---

## Task 9: Exclude worker entry trees + keep exclusion-parity

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties` (mirror, to keep `audit:exclusion-parity` green)

- [ ] **Step 1: Add the worker exclusions**

In `scripts/coverage-floor/exclusions.ts`, add to the frozen `EXCLUSIONS` array (with a comment) — workers run in a Bun realm the preload can't reach (parity with native coverage):

```ts
  // Worker entry points run in a separate Bun realm that does not inherit the
  // [test].preload, so they are uninstrumented under both istanbul AND Bun
  // native coverage. Documented blind spot; a probe to instrument them is
  // deferred to Sub-project D (true-coverage program).
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
```

> Note: `embedding-worker.ts` and `query-guard-worker.ts` are already exempted via the existing `embedding-worker.ts` / `query-guard-worker.ts` entries near the top of the file — if present, do NOT duplicate; only add whichever is missing. (Check first: `grep -n "worker" scripts/coverage-floor/exclusions.ts`.)

- [ ] **Step 2: Mirror in sonar + verify parity**

If you added any path above, add the same path to `sonar.coverage.exclusions` in `sonar-project.properties`. Then run:

Run: `bun run audit:exclusion-parity`
Expected: PASS (no drift between the registry and sonar).

- [ ] **Step 3: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "chore(coverage): exempt worker entry trees from the branch floor"
```

---

## Task 10: Reseed the v2 baseline from CI-Linux + green the gate

> The baseline is **Linux-authoritative**. Do this against CI's lcov, not the Windows dev box. Until the v2 baseline is committed, the gate fails (every sub-80%-branch file is a `below_floor`). This task lands the migration atomically.

- [ ] **Step 1: Push the branch to trigger CI**

```bash
git push -u origin dev/asafgolombek/true-coverage-program
```

- [ ] **Step 2: Wait for the Linux coverage job, then download its lcov**

Run:
```bash
gh run list --branch dev/asafgolombek/true-coverage-program --limit 1
gh run download <run-id> --name coverage-lcov-merged --dir coverage
```
Expected: `coverage/lcov.info` from CI is on disk, containing `BRDA:` records. Confirm: `grep -c '^BRDA:' coverage/lcov.info` is non-zero.

**No `gh` CLI?** (plan review #2) Open the run on github.com → the workflow run page → the **Artifacts** section → download **`coverage-lcov-merged`** → unzip it and place `lcov.info` at `coverage/lcov.info` in the worktree. The rest of Task 10 is identical.

- [ ] **Step 3: Regenerate the v2 baseline from CI's lcov**

Run: `COVERAGE_LCOV_PATH=coverage/lcov.info bun run audit:coverage-floor:update-baseline`
Expected: `docs/structure-audit/coverage-baseline.json` is rewritten as `version: 2` with `{min_line_pct, min_branch_pct}` entries — likely **many** entries (the large day-1 branch baseline, by design).

- [ ] **Step 4: Verify the gate now passes against CI's lcov**

Run: `COVERAGE_LCOV_PATH=coverage/lcov.info bun run audit:coverage-floor`
Expected: `coverage-floor: ok (...)` exit 0.

- [ ] **Step 5: Commit the migration atomically + push**

```bash
git add docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage): reseed v2 line+branch baseline from CI-Linux lcov"
git push
```

- [ ] **Step 6: Confirm CI is green**

Run: `gh run list --branch dev/asafgolombek/true-coverage-program --limit 1`
Expected: the latest run's coverage-floor + exclusion-parity steps pass. If a handful of files differ between your local and CI lcov, re-run Steps 2–5.

---

## Task 11: Rollout verification gates (design spec §5.7)

Run these on the CI-Linux output (download artifacts as in Task 10) before declaring Sub-project A done.

- [ ] **Step 1: Aggregation correctness** — confirm `coverage/lcov.info` covers files from **every** package (gateway/cli/sdk/client/connectors), proving shards from all per-package invocations merged. Run: `grep '^SF:' coverage/lcov.info | sed 's|/src/.*||' | sort -u` and check each package appears.

- [ ] **Step 2: Source-map / line fidelity** — pick 2–3 known-branchy gateway files; eyeball that the `BRDA:<line>` numbers fall on real branch lines in the original `.ts` (open the file, compare). No off-by-one drift.

- [ ] **Step 3: Perf** — compare the instrumented Linux coverage job wall-clock to the prior ~70s baseline (GitHub Actions timing). Confirm within the +3–10s expectation; if materially worse, note it in the PR.

- [ ] **Step 4: `mock.module` interaction** — confirm the combined `packages/cli/src` tests still pass under instrumentation on CI-Linux (no new `mock.module` contamination failures vs the known-flaky baseline).

- [ ] **Step 5: Canary guard** — confirm a branch-heavy file (e.g. `packages/gateway/src/engine/executor.ts`) shows `BRF` > 0 in the lcov: `grep -A50 'SF:packages/gateway/src/engine/executor.ts' coverage/lcov.info | grep '^BRF:'`. This is the safety net for the one risk that `branchPct = (branches===0 ? 100)` hides (plan review #4): a file that *has* branches but for which instrumentation silently emitted no `BRDA` would read as a false 100%. A genuinely branchless file legitimately reporting 100% is correct and standard (SonarCloud agrees). Codify this canary/global `BRF>0` assertion into `check.ts` per spec §5.3.

- [ ] **Step 6: Open the PR**

```bash
gh pr create --fill --base main
```
Title: `feat(coverage): branch-coverage foundation (true-coverage Sub-project A)`. In the body, link the design spec and note the day-1 branch baseline size + the §5.7 gate results.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §5.2 new files → Tasks 4–6; §5.3 the 6 modified files → Tasks 1,2,3,7,8,10 (+ exclusions Task 9); §5.4 atomic migration → Task 10 Step 5; §5.5 Linux-authoritative → Task 10; §5.6 testing → Tasks 1–3,6 tests; §5.7 gates → Task 11; §5.2.1 aggregation → Tasks 5,6,11; §5.2.2 pinned deps → Task 0. Covered.
- **Type consistency:** `FileCoverage` (Task 1) gains `branchPct`, consumed by `lcovToBranchPctMap` (Task 3). `Baseline.files: Map<string, FileFloor>` (Task 2) consumed by `computeBaselineDiff`/`computeUpdatedBaseline`/`evaluateCheck` (Tasks 2,3). `mergeShardsToLcov(repoRoot)` (Task 6) called by build-lcov (Task 7) and CI (Task 8). `shouldInstrument` (Task 4) used by `istanbul-register` (Task 4). Consistent.
- **Placeholders:** none — every code/test step has full content; the only `<...>` are runtime values (`<run-id>`, `<pid>`) the engineer fills from command output.

---

## Plan review dispositions (2026-06-07)

Addressing [the plan review](./2026-06-07-true-coverage-foundation-review.md):

1. **Stale shard accumulation — FIXED.** `mergeShardsToLcov` now `rmSync`-deletes `coverage/.nyc-tmp` after a successful merge (Task 6 Step 3), so a standalone/aborted-run merge can't ingest leftover shards. Orchestrators still `rm -rf coverage` up front — made explicit for the CI step (Task 8 Step 1).
2. **`gh` CLI fallback — FIXED (doc).** Added the manual github.com → Artifacts → `coverage-lcov-merged` download path to Task 10 Step 2.
3. **YAML check dependency — FIXED.** Reframed Task 8 Step 4 as a best-effort local parse (graceful skip if `yaml` isn't installed — no dep added) with the Task 10 push as the authoritative validator.
4. **Zero-branch files — ACKNOWLEDGED.** `branches===0 ? 100` is correct/standard and Sonar-aligned; left as-is. The only failure mode it could mask (instrumentation emits no `BRDA` for a file that has branches → false 100%) is caught by the canary/global `BRF>0` guard — Task 11 Step 5 now states this explicitly and points to codifying it in `check.ts` (spec §5.3).
```
