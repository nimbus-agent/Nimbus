#!/usr/bin/env bun
// Merge per-process istanbul coverage shards (coverage/.nyc-tmp/*.json) into a
// single coverage/lcov.info with repo-root-relative SF paths. Runs once after
// all per-package `bun test` invocations (design spec §5.2.1).
import { Glob } from "bun";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import libCoverage, { type CoverageMapData, type FileCoverageData } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";

// The errno string of a Node fs error, or undefined for anything that isn't one.
// Used to attempt-then-handle rather than existsSync-then-use (which is a TOCTOU
// file-system race, flagged by CodeQL js/file-system-race).
function errnoCode(e: unknown): string | undefined {
  if (e instanceof Error && typeof (e as { code?: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return undefined;
}

export function mergeShardsToLcov(repoRoot: string): number {
  const tmpDir = resolve(repoRoot, "coverage", ".nyc-tmp");
  const merged = libCoverage.createCoverageMap({});
  let shards = 0;
  try {
    for (const file of new Glob("*.json").scanSync({ cwd: tmpDir, absolute: true })) {
      try {
        merged.merge(JSON.parse(readFileSync(file, "utf8")) as CoverageMapData);
        shards += 1;
      } catch (e) {
        console.error(`merge-coverage: skipping unreadable/corrupt shard ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    // No shard dir yet (fresh checkout / direct run) → nothing to merge. Attempt
    // the scan and tolerate "missing" instead of an existsSync precheck (TOCTOU).
    if (errnoCode(e) !== "ENOENT") throw e;
  } finally {
    // Always clean up shards — even a crash-aborted run must not leave stale
    // shards that would fail every later merge (code review I1; plan review #1).
    rmSync(tmpDir, { recursive: true, force: true });
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
  // Normalize SF: path separators to forward slashes on Windows so lcov
  // consumers (SonarCloud, genhtml) receive portable paths.
  const lcovPath = resolve(repoRoot, "coverage", "lcov.info");
  try {
    // Read-then-rewrite directly; tolerate "missing" (the lcovonly reporter
    // writes nothing when the coverage map is empty). No existsSync precheck —
    // that check-then-read gap is a TOCTOU race (CodeQL js/file-system-race).
    writeFileSync(lcovPath, readFileSync(lcovPath, "utf8").replaceAll("\\", "/")); // cross-platform-ok
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
  }
  return shards;
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const shards = mergeShardsToLcov(repoRoot);
  console.log(`merge-coverage: merged ${shards} shard(s) -> coverage/lcov.info`);
}
