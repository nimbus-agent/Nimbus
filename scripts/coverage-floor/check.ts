#!/usr/bin/env bun
// Per-file coverage-floor gate.
// Operator reference: docs/contributors/coverage.md.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

import {
  type Baseline,
  type BaselineDiff,
  computeBaselineDiff,
  FLOOR_PCT,
  parseBaseline,
  serializeBaseline,
} from "./baseline.ts";
import { isExempt } from "./exclusions.ts";
import { parseLcov } from "./lcov-parse.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// ─── Pure orchestrator (testable) ───────────────────────────────────────────

export interface EvaluateInput {
  readonly sourceFiles: ReadonlyArray<string>;
  readonly actual: ReadonlyMap<string, number>;
  readonly baseline: Baseline;
}

export type Violation =
  | { kind: "below_floor"; path: string; actual: number }
  | { kind: "missing_from_lcov"; path: string }
  | { kind: "regression"; path: string; baseline: number; actual: number }
  | { kind: "must_raise"; path: string; baseline: number; actual: number }
  | { kind: "must_remove"; path: string; actual: number };

export interface EvaluateResult {
  readonly exitCode: 0 | 1;
  readonly violations: ReadonlyArray<Violation>;
  readonly diff: BaselineDiff;
}

export function evaluateCheck(input: EvaluateInput): EvaluateResult {
  const violations: Violation[] = [];
  // Rule 1+: every non-exempt source file gets a coverage check.
  for (const path of input.sourceFiles) {
    if (isExempt(path)) continue;
    if (input.baseline.files.has(path)) continue; // baseline rules below
    const actualPct = input.actual.get(path);
    if (actualPct === undefined) {
      violations.push({ kind: "missing_from_lcov", path });
    } else if (actualPct < FLOOR_PCT) {
      violations.push({ kind: "below_floor", path, actual: actualPct });
    }
  }
  // Rule 2-5: baseline-file ratchet.
  const diff = computeBaselineDiff(input.baseline, input.actual);
  for (const r of diff.regressions) {
    violations.push({ kind: "regression", path: r.path, baseline: r.baseline, actual: r.actual });
  }
  for (const m of diff.mustRaise) {
    violations.push({ kind: "must_raise", path: m.path, baseline: m.baseline, actual: m.actual });
  }
  for (const m of diff.mustRemove) {
    violations.push({ kind: "must_remove", path: m.path, actual: m.actual });
  }
  return { exitCode: violations.length === 0 ? 0 : 1, violations, diff };
}

// `--update-baseline` mode: raise must-raise watermarks, drop must-remove
// entries. Regressions are NOT auto-fixed — the PR author must fix the
// regression in code; updating the baseline downward would silently lose
// progress (the whole point of the ratchet).
export function computeUpdatedBaseline(
  baseline: Baseline,
  actual: ReadonlyMap<string, number>,
  sourceFiles: ReadonlyArray<string>,
  generatedAt: string,
): Baseline {
  const next = new Map<string, number>();
  // Pass 1: existing baseline entries — apply ratchet rules.
  for (const [path, minPct] of baseline.files) {
    const actualPct = actual.get(path) ?? 0;
    if (actualPct >= FLOOR_PCT) continue; // must-remove
    if (actualPct > minPct) {
      next.set(path, actualPct); // must-raise
    } else {
      next.set(path, minPct); // stable or regression (keep old watermark)
    }
  }
  // Pass 2: seed new entries for non-exempt source files not already in
  // baseline that are below the floor. Files missing from lcov entirely
  // are recorded at 0 so the first run's missing_from_lcov violations get
  // baselined too — Phase 0's design assumes the seeded baseline accepts
  // current state so CI goes green on merge.
  for (const path of sourceFiles) {
    if (isExempt(path)) continue;
    if (next.has(path)) continue;
    if (baseline.files.has(path)) continue;
    const actualPct = actual.get(path) ?? 0;
    if (actualPct >= FLOOR_PCT) continue;
    next.set(path, actualPct);
  }
  return { version: 1, generated_at: generatedAt, files: next };
}

// ─── I/O boundary ───────────────────────────────────────────────────────────

export async function discoverSourceFiles(): Promise<string[]> {
  // Scope: packages whose coverage lcov is merged into coverage/lcov.info
  // by scripts/coverage-floor/build-lcov.sh (mirroring CI). Excludes:
  //   - packages/ui            (Vitest, separate lcov)
  //   - packages/vscode-extension (Vitest, separate lcov)
  //   - packages/docs          (no tests)
  // A future phase can extend the gate to those packages by merging
  // their Vitest lcov into coverage/lcov.info first.
  const seen = new Set<string>();
  const out: string[] = [];
  const globs = [
    new Glob("packages/gateway/src/**/*.ts"),
    new Glob("packages/gateway/src/**/*.tsx"),
    new Glob("packages/cli/src/**/*.ts"),
    new Glob("packages/cli/src/**/*.tsx"),
    new Glob("packages/sdk/src/**/*.ts"),
    new Glob("packages/client/src/**/*.ts"),
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
  return out.sort();
}

function lcovToPctMap(map: ReturnType<typeof parseLcov>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [path, fc] of map) out.set(path, fc.pct);
  return out;
}

function printViolations(violations: ReadonlyArray<Violation>): void {
  for (const v of violations) {
    switch (v.kind) {
      case "below_floor":
        console.error(`::error file=${v.path}::coverage ${v.actual}% < ${FLOOR_PCT}% floor`);
        break;
      case "missing_from_lcov":
        console.error(
          `::error file=${v.path}::file has no coverage data in lcov (treated as 0%); add a test or add to the baseline`,
        );
        break;
      case "regression":
        console.error(
          `::error file=${v.path}::coverage regressed from ${v.baseline}% to ${v.actual}%`,
        );
        break;
      case "must_raise":
        console.error(
          `::error file=${v.path}::coverage rose from ${v.baseline}% to ${v.actual}% — baseline must be raised in this PR (run: bun run audit:coverage-floor:update-baseline)`,
        );
        break;
      case "must_remove":
        console.error(
          `::error file=${v.path}::coverage is ${v.actual}% (>= ${FLOOR_PCT}%) — baseline entry must be removed in this PR (run: bun run audit:coverage-floor:update-baseline)`,
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
  const actual = lcovToPctMap(parseLcov(lcovText));
  const baseline = existsSync(absBaseline)
    ? parseBaseline(await Bun.file(absBaseline).text())
    : ({
        version: 1 as const,
        generated_at: new Date().toISOString(),
        files: new Map<string, number>(),
      } as Baseline);
  const sourceFiles = await discoverSourceFiles();

  if (updateMode) {
    const next = computeUpdatedBaseline(baseline, actual, sourceFiles, new Date().toISOString());
    await Bun.write(absBaseline, serializeBaseline(next));
    console.log(
      `coverage-floor: updated baseline at ${baselinePath} (${next.files.size} entries; was ${baseline.files.size})`,
    );
    return;
  }

  const result = evaluateCheck({ sourceFiles, actual, baseline });
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
