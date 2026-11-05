// packages/gateway/src/connectors/lazy-mesh/obsidian-write-grant.ts
// Which Obsidian vaults the sandbox write grant may consider (I15, Phase 9.7 B4b). Pure: every
// filesystem fact arrives through `deps`. No vault is ever granted write: since the owner's
// file-only ruling, `obsidian-daily-note-grant.ts` grants each kept vault's daily-note FILE alone.
import { findProtectedOverlap, isSameOrInside, pathApiFor } from "../../util/path-overlap.ts";

/**
 * Why a discovered vault is not granted:
 *  - `outside-roots`: not inside any configured root, by its spelling or by its real path;
 *  - `link`: inside a root by spelling, but its real path is not that root's real path plus the
 *    same names (it is, or passes through, a symlink or junction);
 *  - `missing`: its real path cannot be resolved (gone, or a dangling link);
 *  - `home-or-root`: a filesystem root, the home directory, or an ancestor of the home directory;
 *  - `protected`: overlaps a Nimbus directory (data, config, sandbox, extensions);
 *  - `nested`: inside another vault that is granted (the outer one covers it).
 */
export type ObsidianGrantSkip =
  | "outside-roots"
  | "link"
  | "missing"
  | "home-or-root"
  | "protected"
  | "nested";

export interface ObsidianWriteGrantDeps {
  /** Production: `connectors/obsidian-discovery.ts` `discoverVaultsForWriteGrant`. */
  discoverVaults(roots: readonly string[]): readonly string[];
  /** Production: `realpathSync.native` (the spelling the per-OS runners grant). Throws when unresolvable. */
  realpath(p: string): string;
  readonly homeDir: string;
  /** Nimbus's data, config and sandbox dirs plus the extensions dir. */
  readonly protectedRoots: readonly string[];
  readonly platform: NodeJS.Platform;
}

export interface ObsidianWriteGrant {
  /** Canonical vaults whose daily note may be granted, sorted. Never a root unless that root IS a vault. */
  readonly paths: readonly string[];
  /** Each discovered vault that is not granted, as discovered, with its reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: ObsidianGrantSkip }[];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sameRealPath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const api = pathApiFor(platform);
  const norm = (p: string): string => {
    const n = api.normalize(p);
    return platform === "win32" ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

function tryRealpath(deps: ObsidianWriteGrantDeps, p: string): string | undefined {
  try {
    return deps.realpath(p);
  } catch {
    return undefined;
  }
}

/** A filesystem root (`/`, `C:\`), the home directory, or an ancestor of it. */
function isHomeOrFilesystemRoot(deps: ObsidianWriteGrantDeps, canonical: string): boolean {
  const api = pathApiFor(deps.platform);
  if (api.parse(canonical).root === api.normalize(canonical)) return true;
  if (api.dirname(canonical) === canonical) return true;
  const home = tryRealpath(deps, deps.homeDir) ?? deps.homeDir;
  return (
    isSameOrInside(deps.platform, deps.homeDir, canonical) ||
    isSameOrInside(deps.platform, home, canonical)
  );
}

/**
 * The containment test. A vault is contained when, for some configured root `r`, all three hold:
 *  1. by REAL path, it is `realpath(r)` or inside it (`isSameOrInside`): a symlink or junction
 *     that leads out of every root fails here, `outside-roots`;
 *  2. by SPELLING, it is `r` or inside it;
 *  3. its real path is exactly `realpath(r)` joined with the same relative names, so no component
 *     between the root and the vault is a link (a link that stays inside the roots fails here,
 *     `link`: the grant never follows a link, wherever it points).
 * Returns the skip reason, or `undefined` when contained.
 */
function containmentSkip(
  deps: ObsidianWriteGrantDeps,
  vault: string,
  canonicalVault: string,
  roots: readonly string[],
): ObsidianGrantSkip | undefined {
  const api = pathApiFor(deps.platform);
  let insideByRealPath = false;
  for (const root of roots) {
    const canonicalRoot = tryRealpath(deps, root);
    if (canonicalRoot === undefined) continue;
    if (!isSameOrInside(deps.platform, canonicalVault, canonicalRoot)) continue;
    insideByRealPath = true;
    if (!isSameOrInside(deps.platform, vault, root)) continue;
    const rel = api.relative(api.resolve(root), api.resolve(vault));
    const expected = rel === "" ? canonicalRoot : api.join(canonicalRoot, rel);
    if (sameRealPath(deps.platform, expected, canonicalVault)) return undefined;
  }
  return insideByRealPath ? "link" : "outside-roots";
}

/**
 * The directories the Obsidian sandbox may write: each discovered vault, canonicalised, that is
 * inside a configured root without crossing a link, is not a filesystem root, the home directory or
 * an ancestor of it, does not overlap a protected Nimbus directory, and is not inside another kept
 * vault. The roots themselves are never added (they stay read-only) unless a root IS a vault.
 */
export function obsidianWriteGrantPaths(
  roots: readonly string[],
  deps: ObsidianWriteGrantDeps,
): ObsidianWriteGrant {
  const skipped: { path: string; reason: ObsidianGrantSkip }[] = [];
  const candidates: string[] = [];
  for (const vault of deps.discoverVaults(roots)) {
    const canonical = tryRealpath(deps, vault);
    if (canonical === undefined) {
      skipped.push({ path: vault, reason: "missing" });
      continue;
    }
    const contained = containmentSkip(deps, vault, canonical, roots);
    if (contained !== undefined) {
      skipped.push({ path: vault, reason: contained });
      continue;
    }
    if (isHomeOrFilesystemRoot(deps, canonical)) {
      skipped.push({ path: vault, reason: "home-or-root" });
      continue;
    }
    if (
      findProtectedOverlap(canonical, deps.protectedRoots, deps.platform, deps.realpath) !==
      undefined
    ) {
      skipped.push({ path: vault, reason: "protected" });
      continue;
    }
    candidates.push(canonical);
  }
  // Outermost first, so a nested vault always meets the vault that covers it; a duplicate (two
  // roots reaching the same vault, or win32 case variants) is dropped silently.
  candidates.sort((a, b) => a.length - b.length || compareStrings(a, b));
  const kept: string[] = [];
  for (const c of candidates) {
    if (kept.some((k) => sameRealPath(deps.platform, k, c))) continue;
    if (kept.some((k) => isSameOrInside(deps.platform, c, k))) {
      skipped.push({ path: c, reason: "nested" });
      continue;
    }
    kept.push(c);
  }
  kept.sort(compareStrings);
  return { paths: kept, skipped };
}
