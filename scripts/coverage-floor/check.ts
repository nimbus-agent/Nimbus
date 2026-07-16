#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

import {
  type Baseline,
  type BaselineDiff,
  BRANCH_FLOOR_PCT,
  computeBaselineDiff,
  FLOOR_PCT,
  parseBaseline,
  serializeBaseline,
} from "./baseline.ts";
import { isExempt } from "./exclusions.ts";
import { parseLcov } from "./lcov-parse.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export interface EvaluateInput {
  readonly sourceFiles: ReadonlyArray<string>;
  readonly actualLine: ReadonlyMap<string, number>;
  readonly actualBranch: ReadonlyMap<string, number>;
  readonly baseline: Baseline;
}

export type Violation =
  | { kind: "below_floor"; dimension: "line" | "branch"; path: string; actual: number }
  | { kind: "missing_from_lcov"; path: string }
  | {
      kind: "regression";
      dimension: "line" | "branch";
      path: string;
      baseline: number;
      actual: number;
    }
  | { kind: "must_raise"; path: string }
  | { kind: "must_remove"; path: string }
  | {
      kind: "below_target";
      dimension: "line" | "branch";
      path: string;
      actual: number;
      required: number;
    };

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
    if (line < FLOOR_PCT)
      violations.push({ kind: "below_floor", dimension: "line", path, actual: line });
    const branch = input.actualBranch.get(path) ?? 100;
    if (branch < BRANCH_FLOOR_PCT)
      violations.push({ kind: "below_floor", dimension: "branch", path, actual: branch });
  }
  const diff = computeBaselineDiff(input.baseline, input.actualLine, input.actualBranch);
  for (const r of diff.regressions) {
    violations.push({
      kind: "regression",
      dimension: r.dimension,
      path: r.path,
      baseline: r.baseline,
      actual: r.actual,
    });
  }
  for (const m of diff.mustRaise) violations.push({ kind: "must_raise", path: m.path });
  for (const m of diff.mustRemove) violations.push({ kind: "must_remove", path: m.path });
  // Flagship 100% targets — a stricter, hand-curated ceiling above the global floor. Each listed
  // file must meet its required line AND branch pct; a missing target file reads as 0% line
  // (fail-closed). This is purely additive to the floor/ratchet pass above and is never relaxed by
  // `update-baseline` (the targets section is round-tripped verbatim).
  for (const [path, req] of input.baseline.targets) {
    const line = input.actualLine.get(path) ?? 0;
    const branch = input.actualBranch.get(path) ?? 100;
    if (line < req.line)
      violations.push({
        kind: "below_target",
        dimension: "line",
        path,
        actual: line,
        required: req.line,
      });
    if (branch < req.branch)
      violations.push({
        kind: "below_target",
        dimension: "branch",
        path,
        actual: branch,
        required: req.branch,
      });
  }
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
    const storeBranch =
      branch >= BRANCH_FLOOR_PCT ? BRANCH_FLOOR_PCT : Math.max(existing?.branch ?? 0, branch);
    next.set(path, { line: storeLine, branch: storeBranch });
  };
  for (const path of baseline.files.keys()) consider(path);
  for (const path of sourceFiles) {
    if (isExempt(path)) continue;
    consider(path);
  }
  // Round-trip the flagship 100% targets verbatim — the ratchet only manages below-floor debt and
  // must never touch (or drop) a hand-curated 100% ceiling.
  return { version: 2, generated_at: generatedAt, files: next, targets: baseline.targets };
}

export async function discoverSourceFiles(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const globs = [
    new Glob("packages/gateway/src/**/*.ts"),
    new Glob("packages/gateway/src/**/*.tsx"),
    new Glob("packages/cli/src/**/*.ts"),
    new Glob("packages/cli/src/**/*.tsx"),
    new Glob("packages/mcp-connectors/*/src/**/*.ts"),
  ];
  for (const glob of globs) {
    for await (const rawRel of glob.scan({ cwd: REPO_ROOT })) {
      const rel = rawRel.replaceAll("\\", "/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (rel.endsWith(".test.ts")) continue;
      if (rel.endsWith(".test.tsx")) continue;
      if (rel.endsWith(".d.ts")) continue;
      if (rel.includes("/__fixtures__/")) continue;
      if (rel.includes("/test/fixtures/")) continue;
      if (rel.includes("/testing/")) continue;
      out.push(rel);
    }
  }
  return out.sort((a, b) => (a > b ? 1 : -1));
}

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

// Instrumentation canary (spec §5.3/§5.7). A real instrumented run emits tens of
// thousands of BRDA records. If the lcov carries source files but ZERO branch
// records total, istanbul instrumentation silently produced no branch data —
// `branchPct` then defaults to 100 for every file, so the branch floor would be
// a no-op and pass falsely. Returns false ONLY in that broken case; an entirely
// empty lcov is a different failure (lcov-not-found / missing_from_lcov) and
// returns true here so those paths report it.
export function lcovHasBranchData(map: ReturnType<typeof parseLcov>): boolean {
  if (map.size === 0) return true;
  for (const fc of map.values()) {
    if (fc.branches > 0) return true;
  }
  return false;
}

function printViolations(violations: ReadonlyArray<Violation>): void {
  for (const v of violations) {
    switch (v.kind) {
      case "below_floor":
        console.error(
          `::error file=${v.path}::${v.dimension} coverage ${v.actual}% < ${v.dimension === "line" ? FLOOR_PCT : BRANCH_FLOOR_PCT}% floor`,
        );
        break;
      case "missing_from_lcov":
        console.error(
          `::error file=${v.path}::file has no coverage data in lcov (treated as 0%); add a test or add to the baseline`,
        );
        break;
      case "regression":
        console.error(
          `::error file=${v.path}::${v.dimension} coverage regressed from ${v.baseline}% to ${v.actual}%`,
        );
        break;
      case "must_raise":
        console.error(
          `::error file=${v.path}::coverage improved above its baseline watermark — run: bun run audit:coverage-floor:update-baseline`,
        );
        break;
      case "must_remove":
        console.error(
          `::error file=${v.path}::coverage now clears both floors — remove the baseline entry: bun run audit:coverage-floor:update-baseline`,
        );
        break;
      case "below_target":
        console.error(
          `::error file=${v.path}::${v.dimension} coverage ${v.actual}% < required ${v.required}% (flagship target — this security-core file is pinned at ${v.required}%; add tests, do NOT lower the target)`,
        );
        break;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateMode = args.includes("--update-baseline");
  const baselinePathArg = args.find((_a, i) => args[i - 1] === "--baseline");
  const baselinePath = baselinePathArg ?? "docs/structure-audit/coverage-baseline.json";
  const lcovPath = process.env["COVERAGE_LCOV_PATH"] ?? "coverage/lcov.info";

  const absBaseline = resolve(REPO_ROOT, baselinePath);
  const absLcov = resolve(REPO_ROOT, lcovPath);

  if (!existsSync(absLcov)) {
    console.error(
      `coverage-floor: lcov not found at ${lcovPath}; run \`bun run test:coverage\` first`,
    );
    process.exit(2);
  }

  const lcovText = await Bun.file(absLcov).text();
  const parsed = parseLcov(lcovText);
  if (!lcovHasBranchData(parsed)) {
    console.error(
      `coverage-floor: lcov at ${lcovPath} has source files but ZERO branch (BRDA) records — istanbul instrumentation is broken; every file would read as a false 100% branch. Aborting (re-check the [test].preload wiring).`,
    );
    process.exit(2);
  }
  const actualLine = lcovToLinePctMap(parsed);
  const actualBranch = lcovToBranchPctMap(parsed);
  const baseline = existsSync(absBaseline)
    ? parseBaseline(await Bun.file(absBaseline).text())
    : ({
        version: 2 as const,
        generated_at: new Date().toISOString(),
        files: new Map<string, { line: number; branch: number }>(),
        targets: new Map<string, { line: number; branch: number }>(),
      } as Baseline);
  const sourceFiles = await discoverSourceFiles();

  if (updateMode) {
    const next = computeUpdatedBaseline(
      baseline,
      actualLine,
      actualBranch,
      sourceFiles,
      new Date().toISOString(),
    );
    await Bun.write(absBaseline, serializeBaseline(next));
    console.log(
      `coverage-floor: updated baseline at ${baselinePath} (${next.files.size} entries; was ${baseline.files.size})`,
    );
    return;
  }

  const result = evaluateCheck({ sourceFiles, actualLine, actualBranch, baseline });
  if (result.violations.length === 0) {
    console.log(
      `coverage-floor: ok (${baseline.files.size} baselined files; ${sourceFiles.length} source files scanned)`,
    );
    process.exit(0);
  }
  printViolations(result.violations);
  console.error(
    `coverage-floor: FAILED (${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}). See errors above.`,
  );
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
