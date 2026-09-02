import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";

const REGISTERED_ROOTS_FILE = "registered-roots.json";

// Registered (editor/CLI-added) roots are blame-oriented: git-aware, but without
// the code-symbol scan or the dependency graph. Excludes mirror the TOML default.
const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", "target", "build", ".next"] as const;

/**
 * Resolve + real-path a candidate root, stripping the Windows `\\?\` long-path
 * prefix so the result is byte-identical to the path git sees via `-C` (and thus
 * matches the SQLite `git_blame_line.repo_root` key). Returns `null` if the path
 * does not resolve.
 */
export function canonicalizeRootPath(p: string): string | null {
  try {
    let r = realpathSync(resolve(p));
    if (r.startsWith("\\\\?\\")) r = r.slice(4);
    return r;
  } catch {
    return null; // does not resolve
  }
}

function rootsFilePath(configDir: string): string {
  return join(configDir, REGISTERED_ROOTS_FILE);
}

function readRegisteredPaths(configDir: string): string[] {
  const path = rootsFilePath(configDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Append a canonical root to `registered-roots.json`. Returns `false` (a no-op)
 * if the exact path is already present. The caller supplies an already
 * `canonicalizeRootPath`-normalized path.
 */
export function addRegisteredRoot(configDir: string, canonicalPath: string): boolean {
  const paths = readRegisteredPaths(configDir);
  if (paths.includes(canonicalPath)) return false;
  paths.push(canonicalPath);
  writeFileSync(rootsFilePath(configDir), `${JSON.stringify(paths, null, 2)}\n`, "utf8");
  return true;
}

/** Load registered roots as blame-oriented `NimbusFilesystemRootToml` entries. */
export function loadRegisteredRoots(configDir: string): NimbusFilesystemRootToml[] {
  return readRegisteredPaths(configDir).map((path) => ({
    path,
    gitAware: true,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [...DEFAULT_EXCLUDE],
  }));
}

function dedupeKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Merge TOML-configured roots with editor/CLI-registered roots. Dedupe by
 * canonical path (case-folded on win32); **TOML wins** on collision. Any root
 * whose folder no longer exists is skipped (with a stderr warning) so a stale
 * registration never blocks startup.
 */
export function mergeRoots(
  tomlRoots: readonly NimbusFilesystemRootToml[],
  registered: readonly NimbusFilesystemRootToml[],
): NimbusFilesystemRootToml[] {
  const byKey = new Map<string, NimbusFilesystemRootToml>();
  for (const r of registered) byKey.set(dedupeKey(r.path), r);
  for (const r of tomlRoots) byKey.set(dedupeKey(r.path), r); // TOML overrides
  const out: NimbusFilesystemRootToml[] = [];
  for (const r of byKey.values()) {
    if (!existsSync(r.path)) {
      process.stderr.write(`nimbus: skipping root (folder missing): ${r.path}\n`);
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * The COMPLETE set of git-aware root paths across BOTH root sources — the
 * `[[filesystem.roots]]` TOML blocks and `registered-roots.json` (written by
 * `nimbus index add`).
 *
 * Consumers that clear-and-re-emit derived state keyed on roots (the ownership
 * pass) MUST use this rather than the TOML roots alone: `git_blame_line` is
 * populated for the merged set (see `registerFilesystemRootSyncables` in
 * `platform/assemble.ts`), so a TOML-only root set both misses every path under
 * a CLI-registered root AND erases the ownership already derived for any
 * service that root binds.
 *
 * Delegates to `mergeRoots`, so TOML wins on a same-path collision and a root
 * whose folder is missing is dropped.
 */
export function gitAwareRootPaths(
  tomlRoots: readonly NimbusFilesystemRootToml[],
  registered: readonly NimbusFilesystemRootToml[],
): string[] {
  return mergeRoots(tomlRoots, registered)
    .filter((r) => r.gitAware)
    .map((r) => r.path);
}
