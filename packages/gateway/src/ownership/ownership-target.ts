import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { matchConfiguredRoot } from "../agents/_lib/why-subject.ts";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { gitAwareRootPaths, loadRegisteredRoots } from "../index/registered-roots-store.ts";

/** A caller path mapped onto a configured root. `relPath` is `""` for the root itself. */
export type ResolvedOwnershipPath = {
  readonly repoRoot: string;
  readonly relPath: string;
};

/**
 * The COMPLETE git-aware root set — BOTH `[[filesystem.roots]]` TOML blocks and the
 * CLI-registered roots in `registered-roots.json`.
 *
 * This must match what `platform/assemble.ts` hands `runOwnershipPass` exactly. Copying
 * `agents/why.ts`'s `whyRoots` (TOML only) would report "no ownership data" for every path
 * under a `nimbus index add` root — paths the pass has already blamed, ranked and written
 * edges for, because `registerFilesystemRootSyncables` runs the blame indexer over the
 * merged set. `gitAwareRootPaths` is the single source of truth for that set and carries
 * the doc comment saying so.
 */
export function ownershipRoots(configDir: string): string[] {
  return gitAwareRootPaths(
    loadNimbusFilesystemRootsFromConfigDir(configDir),
    loadRegisteredRoots(configDir),
  );
}

/**
 * `matchConfiguredRoot` takes the full TOML record but reads only `.path`. The other
 * fields are filled with the inert values a read path cannot act on.
 */
function asRootRecords(roots: readonly string[]): NimbusFilesystemRootToml[] {
  return roots.map((path) => ({
    path,
    gitAware: true,
    codeIndex: false,
    dependencyGraph: false,
    exclude: [],
  }));
}

/** True when `refPath` names one of the roots itself, rather than something inside one. */
function matchRootItself(roots: readonly string[], refPath: string): ResolvedOwnershipPath | null {
  for (const root of roots) {
    const candidate = isAbsolute(refPath) ? resolve(refPath) : resolve(join(root, refPath));
    if (candidate === resolve(root)) return { repoRoot: root, relPath: "" };
  }
  return null;
}

/**
 * Map a caller-supplied path onto a configured root.
 *
 * The containment fence runs FIRST and unconditionally: `matchConfiguredRoot`
 * (`agents/_lib/why-subject.ts`) rejects a `../` escape in both its absolute and its
 * relative branch before touching the filesystem. The only path past that fence is
 * `matchRootItself`, and it can return nothing but a configured root itself — it compares
 * the resolved candidate against `resolve(root)` per root, so its result is provably one
 * of the caller-configured roots, never an escape.
 * The root-itself case is handled only AFTER that helper has declined, because it is the
 * one legitimate subject the helper is deliberately built to reject (`rel === ""`) — see
 * the spec §5.2. Extending that shared helper with an `allowRoot` flag was rejected: one
 * caller's needs should not reshape a security primitive `why` depends on.
 */
export function resolveOwnershipPath(
  roots: readonly string[],
  refPath: string,
  exists: (p: string) => boolean = existsSync,
): ResolvedOwnershipPath | null {
  const records = asRootRecords(roots);
  const matched = matchConfiguredRoot(records, refPath, exists);
  if (matched !== null) return { repoRoot: matched.repoRoot, relPath: matched.filePath };
  return matchRootItself(roots, refPath);
}
