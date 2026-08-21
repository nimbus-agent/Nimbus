#!/usr/bin/env bun
// scripts/ci/changed-test-targets.ts — which test files `verify:docker --changed` should run.
//
// Feeds the Linux-reproduction fast path. Of the 18 failed PR runs sampled on 2026-08-21, the
// single largest real failure category was "Unit tests (with coverage) — Linux" (6) — failures
// that do not reproduce on a Windows or macOS dev box at all, so the only way to see one has been
// to push and wait ~12 minutes. This picks the narrow set worth running in the CI image instead.
//
// ── What a narrow run CANNOT reproduce ────────────────────────────────────────────────────────
// `mock.module` contamination — the best-documented CI-Linux-only failure in this repo — is a
// CROSS-FILE effect: a registration in one file leaks into another in the same `bun test` process.
// It reproduces in the COMBINED `bun test packages/cli/src` run and NOT in a per-file run. So a
// green `--changed` is evidence about YOUR files, never about the suite. `--full` remains the
// authority. This bound is stated in the runner's output too, not just here, because a tool that
// prints "PASSED" teaches more than a comment does.

import { changedFiles } from "./changed-files.ts";

const TEST_SUFFIX = /\.test\.tsx?$/;
/** Source roots whose files have a colocated `<name>.test.ts` by convention. */
const COLOCATED_ROOTS = ["packages/gateway/src/", "packages/cli/src/", "packages/mcp-connectors/"];

/**
 * Map changed files to test files worth running.
 *
 * Two sources, unioned:
 *   1. a changed test file — run it
 *   2. a changed SOURCE file under a colocated root — run its `<name>.test.ts` sibling
 *
 * `exists` is injected so the mapping is unit-testable without a filesystem. Deliberately does
 * NOT walk importers: a transitive-dependency search is the full suite by another name, and the
 * caller reaches for this when they want the fast one.
 */
export function testTargetsFor(
  files: readonly string[],
  exists: (path: string) => boolean,
): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const path = f.replaceAll("\\", "/");
    if (TEST_SUFFIX.test(path)) {
      out.add(path);
      continue;
    }
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    if (!COLOCATED_ROOTS.some((r) => path.startsWith(r))) continue;
    const sibling = path.replace(/\.tsx?$/, (m) => `.test${m}`);
    if (exists(sibling)) out.add(sibling);
  }
  return [...out].sort();
}

async function main(): Promise<number> {
  const targets = testTargetsFor(changedFiles(), (p) => Bun.file(p).size > 0);
  // stdout is consumed by verify-in-docker.sh; keep it to bare paths, one per line.
  for (const t of targets) console.log(t);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
