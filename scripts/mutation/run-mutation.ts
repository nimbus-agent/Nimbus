#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

/**
 * From a list of changed paths, keep only the files Stryker may mutate:
 * non-test TypeScript under packages/gateway/src/. Paths are normalized to
 * forward slashes so the filter works on Windows `git diff` output too.
 */
export function filterMutableFiles(changed: readonly string[]): string[] {
  return changed
    .map((p) => p.replaceAll("\\", "/"))
    .filter(
      (p) =>
        p.startsWith("packages/gateway/src/") &&
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".spec.ts"),
    );
}

/** First valid base ref among origin/main, main — else a helpful error. */
function resolveBaseRef(): string {
  for (const ref of ["origin/main", "main"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
    if (r.status === 0) return ref;
  }
  throw new Error(
    "[mutation] Neither 'origin/main' nor 'main' is a valid git ref — run `git fetch origin main` first.",
  );
}

/** Changed gateway-src files vs the base ref (merge-base), filtered to mutable ones. */
function diffMutableFiles(): string[] {
  const baseRef = resolveBaseRef();
  const out = spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  if (out.status !== 0) {
    const err = (out.stderr ?? "").trim();
    throw new Error(`git diff failed: ${err || `exit ${out.status}`}`);
  }
  const lines = out.stdout.split("\n").filter((l) => l.length > 0);
  return filterMutableFiles(lines);
}

function main(): void {
  const useDiff = process.argv.includes("--diff");
  let strykerArgs = ["stryker", "run"];

  if (useDiff) {
    const files = diffMutableFiles();
    if (files.length === 0) {
      console.log(
        "[mutation] No changed packages/gateway/src/*.ts files vs the base ref — nothing to mutate.",
      );
      return; // exit 0; never fall through to an unscoped whole-codebase run
    }
    console.log(`[mutation] Mutating ${files.length} changed file(s):\n  ${files.join("\n  ")}`);
    strykerArgs = ["stryker", "run", "--mutate", files.join(",")];
  }

  const res = spawnSync("bunx", strykerArgs, { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

if (import.meta.main) {
  main();
}
