#!/usr/bin/env bun

/**
 * Per-scope coverage floors — the gates CLAUDE.md advertises ("Engine ≥85%,
 * Vault ≥90%, Embedding ≥80%, plus scheduler/rate-limiter/people").
 *
 * Those floors used to be spelled as `bun test <scope> --coverage
 * --coverage-threshold-lines=N` in 25 package.json scripts. **They enforced
 * nothing**, for two independent reasons, both verified against Bun 1.3.14:
 *
 *   1. `--coverage-threshold-lines` is not a Bun flag. `bun test --help` lists
 *      only `--coverage`, `--coverage-reporter` and `--coverage-dir`, and Bun
 *      ignores unknown flags silently — `bun test x.test.js --totally-bogus-flag=7`
 *      exits 0. A scope at 28% "passed" a threshold of 99%.
 *   2. `bunfig.toml` sets `[test] coverage = false`, which suppresses coverage
 *      collection outright. Even an explicit `--coverage --coverage-reporter=lcov
 *      --coverage-dir=X` writes no lcov at all under that setting, so there was
 *      nothing for a threshold to read even in principle.
 *
 * This module enforces the same floors for real, against the merged lcov that
 * `audit:coverage-floor` already consumes — so it costs no extra test run.
 *
 * TWO DELIBERATE SEMANTICS, both chosen to match the existing floor gate:
 *
 * - **Exempt files are excluded from the denominator.** `audit:coverage-floor`
 *   exempts per-OS and FFI shells that cannot be exercised on a single runner.
 *   Counting them here would make a scope's number describe how much untestable
 *   glue it contains rather than how well its testable code is covered: with
 *   exempt files in, `vault` reads 89.9% and `sandbox` 65.5%; with them out,
 *   both are 100%. The exemptions remain a real hole — `vault/win32.ts` carries
 *   I12 and is measured by nothing — but that hole is not this gate's to close,
 *   and pretending otherwise by reporting a low number here would just add a
 *   second misleading signal.
 * - **A scope matching zero files is a FAILURE, not a pass.** These predicates
 *   name directories that get moved. A silently-empty scope is exactly the
 *   shape of gate that cannot fail.
 *
 * Not covered here, and stated plainly: this reads the LINUX merged lcov, so
 * the floors are enforced on Linux only. That is not a regression — the
 * per-OS jobs never enforced anything — but `vault/win32.ts` and
 * `vault/darwin.ts` still have no floor on their own platforms.
 */

import { readFileSync } from "node:fs";
import { isExempt } from "./exclusions.ts";
import { parseLcov } from "./lcov-parse.ts";

export interface ScopeGate {
  /** Display name, matching the CI job label where one exists. */
  readonly name: string;
  /** Minimum aggregate LINE coverage percentage over non-exempt files. */
  readonly floorLines: number;
  readonly match: (relPath: string) => boolean;
}

const gw = (sub: string) => (p: string) => p.startsWith(`packages/gateway/src/${sub}`);

/**
 * The 24 scopes, carrying the floors the old scripts documented. Every one of
 * them passes today with margin — measured against the merged lcov of main
 * @ de196f8c — so turning enforcement on is not a ratchet reset.
 */
export const SCOPE_GATES: readonly ScopeGate[] = Object.freeze([
  { name: "Agents", floorLines: 80, match: gw("agents/") },
  { name: "Engine", floorLines: 85, match: gw("engine/") },
  { name: "Vault", floorLines: 90, match: gw("vault/") },
  {
    name: "Scheduler",
    floorLines: 80,
    match: (p) => p === "packages/gateway/src/sync/scheduler.ts",
  },
  {
    name: "Rate limiter",
    floorLines: 85,
    match: (p) => p === "packages/gateway/src/sync/rate-limiter.ts",
  },
  { name: "People", floorLines: 80, match: gw("people/") },
  { name: "Embedding", floorLines: 80, match: gw("embedding/") },
  {
    name: "Workflow",
    floorLines: 80,
    match: (p) => p.startsWith("packages/gateway/src/automation/workflow-"),
  },
  {
    name: "Watcher",
    floorLines: 80,
    match: (p) =>
      p.startsWith("packages/gateway/src/automation/watcher-") ||
      p.startsWith("packages/gateway/src/automation/graph-predicate") ||
      p.startsWith("packages/gateway/src/watcher/"),
  },
  { name: "Extensions", floorLines: 85, match: gw("extensions/") },
  { name: "Sandbox", floorLines: 80, match: gw("platform/sandbox/") },
  { name: "Security", floorLines: 80, match: gw("security/") },
  { name: "Config", floorLines: 80, match: gw("config/") },
  { name: "Telemetry", floorLines: 85, match: gw("telemetry/") },
  { name: "DB layer", floorLines: 85, match: gw("db/") },
  { name: "Deployment", floorLines: 80, match: gw("deployment/") },
  { name: "Metrics", floorLines: 80, match: gw("metrics/") },
  { name: "Preflight", floorLines: 80, match: gw("preflight/") },
  {
    name: "Doctor",
    floorLines: 80,
    match: (p) => p.startsWith("packages/cli/src/commands/doctor"),
  },
  {
    name: "MCP connectors",
    floorLines: 70,
    match: (p) => p.startsWith("packages/mcp-connectors/"),
  },
  { name: "TUI", floorLines: 80, match: (p) => p.startsWith("packages/cli/src/tui/") },
  { name: "Updater", floorLines: 80, match: gw("updater/") },
  { name: "LAN", floorLines: 80, match: (p) => p.startsWith("packages/gateway/src/ipc/lan-") },
  { name: "Perf", floorLines: 80, match: gw("perf/") },
]);

export interface ScopeResult {
  readonly name: string;
  readonly floorLines: number;
  readonly files: number;
  readonly linePct: number;
  readonly ok: boolean;
}

export interface ScopeCheckResult {
  readonly ok: boolean;
  readonly results: readonly ScopeResult[];
  readonly errors: readonly string[];
}

export function checkScopes(lcovText: string): ScopeCheckResult {
  const coverage = parseLcov(lcovText);
  const results: ScopeResult[] = [];
  const errors: string[] = [];

  for (const gate of SCOPE_GATES) {
    let covered = 0;
    let lines = 0;
    let files = 0;
    for (const [path, c] of coverage) {
      if (!gate.match(path) || isExempt(path)) continue;
      files += 1;
      covered += c.covered;
      lines += c.lines;
    }

    if (files === 0) {
      errors.push(
        `${gate.name}: matched 0 non-exempt files in the lcov — the scope moved or was renamed. ` +
          `A scope that matches nothing would pass every floor forever, so this fails instead.`,
      );
      results.push({
        name: gate.name,
        floorLines: gate.floorLines,
        files: 0,
        linePct: 0,
        ok: false,
      });
      continue;
    }

    const linePct = lines === 0 ? 100 : (covered / lines) * 100;
    const ok = linePct + 1e-9 >= gate.floorLines;
    if (!ok) {
      errors.push(
        `${gate.name}: ${linePct.toFixed(2)}% line coverage over ${String(files)} non-exempt file(s) ` +
          `— below the ${String(gate.floorLines)}% floor.`,
      );
    }
    results.push({ name: gate.name, floorLines: gate.floorLines, files, linePct, ok });
  }

  return { ok: errors.length === 0, results, errors };
}

if (import.meta.main) {
  const lcovPath = process.argv[2] ?? "coverage/lcov.info";
  let text: string;
  try {
    text = readFileSync(lcovPath, "utf8");
  } catch {
    console.error(
      `audit:coverage-scopes: cannot read ${lcovPath}. Run \`bun run audit:coverage-floor:build-lcov\` first (CI-Linux authoritative).`,
    );
    process.exit(1);
  }

  const result = checkScopes(text);
  for (const r of result.results) {
    const mark = r.ok ? "ok  " : "FAIL";
    console.log(
      `  ${mark} ${r.name.padEnd(16)} ${r.linePct.toFixed(1).padStart(6)}% >= ${String(r.floorLines).padStart(2)}%  (${String(r.files)} files)`,
    );
  }
  if (!result.ok) {
    for (const e of result.errors) console.error(`audit:coverage-scopes: ${e}`);
    process.exit(1);
  }
  console.log(`audit:coverage-scopes: ok (${String(SCOPE_GATES.length)} scopes)`);
}
