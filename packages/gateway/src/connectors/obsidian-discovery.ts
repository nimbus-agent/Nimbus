import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "out",
  "vendor",
  ".cache",
]);

const VAULT_MARKER = ".obsidian";

function isDirectorySafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDirSafe(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function discoverVaults(roots: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const root of roots) {
    walkForVaults(root, out);
  }
  return out;
}

function walkForVaults(dir: string, out: string[]): void {
  if (!isDirectorySafe(dir)) {
    return;
  }
  const entries = readDirSafe(dir);
  if (entries.includes(VAULT_MARKER) && isDirectorySafe(join(dir, VAULT_MARKER))) {
    out.push(dir);
  }
  for (const e of entries) {
    if (e === VAULT_MARKER) {
      continue;
    }
    if (DEFAULT_IGNORED_DIR_NAMES.has(e)) {
      continue;
    }
    const sub = join(dir, e);
    let isDir = false;
    try {
      const st = statSync(sub);
      isDir = st.isDirectory() && !st.isSymbolicLink();
    } catch {
      continue;
    }
    if (isDir) {
      walkForVaults(sub, out);
    }
  }
}

export function discoverNotesInVault(vaultRoot: string): readonly string[] {
  const out: string[] = [];
  walkForNotes(vaultRoot, vaultRoot, out);
  return out;
}

type EntryKind = "dir" | "file" | "skip";

function classifyEntry(full: string): EntryKind {
  try {
    const st = statSync(full);
    if (st.isSymbolicLink()) {
      return "skip";
    }
    if (st.isDirectory()) {
      return "dir";
    }
    if (st.isFile()) {
      return "file";
    }
  } catch {
    return "skip";
  }
  return "skip";
}

function walkForNotes(currentDir: string, vaultRoot: string, out: string[]): void {
  if (!isDirectorySafe(currentDir)) {
    return;
  }
  const entries = readDirSafe(currentDir);
  if (
    currentDir !== vaultRoot &&
    entries.includes(VAULT_MARKER) &&
    isDirectorySafe(join(currentDir, VAULT_MARKER))
  ) {
    return;
  }
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) {
      continue;
    }
    const full = join(currentDir, e);
    const kind = classifyEntry(full);
    if (kind === "file" && full.toLowerCase().endsWith(".md")) {
      out.push(relative(vaultRoot, full).replaceAll("\\", "/"));
    } else if (kind === "dir") {
      walkForNotes(full, vaultRoot, out);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The write-grant walk (Phase 9.7 B4b). A SEPARATE walk from `discoverVaults` above, which feeds
// the gateway's own Obsidian indexing (`obsidian-sync.ts`) and is left exactly as it was. This one
// decides what the Obsidian connector's sandbox may WRITE (`lazy-mesh/obsidian-write-grant.ts`),
// so every difference from it is narrower.
// ---------------------------------------------------------------------------------------------

/**
 * How deep below a configured root the write-grant walk looks for a vault (the root itself is
 * depth 0). The connector walks without a bound; a vault deeper than this is readable by the
 * connector but never granted a write (the append fails there: fail closed).
 */
export const OBSIDIAN_GRANT_DISCOVERY_MAX_DEPTH = 12;

/**
 * How many directories one write-grant walk reads across ALL roots. It runs on the gateway's event
 * loop, so a root over a huge tree must not stall it; a vault past the budget is never granted.
 */
export const OBSIDIAN_GRANT_DISCOVERY_MAX_DIRS = 20_000;

/** The filesystem calls the write-grant walk makes. Injected only by tests; production is `node:fs`. */
export interface ObsidianDiscoveryFs {
  readonly statSync: (p: string) => { isDirectory(): boolean };
  readonly lstatSync: (p: string) => { isDirectory(): boolean; isSymbolicLink(): boolean };
  readonly readdirSync: (p: string) => readonly string[];
}

const NODE_DISCOVERY_FS: ObsidianDiscoveryFs = {
  statSync: (p) => statSync(p),
  lstatSync: (p) => lstatSync(p),
  readdirSync: (p) => readdirSync(p),
};

export interface ObsidianGrantDiscoveryOptions {
  readonly fs?: ObsidianDiscoveryFs;
  readonly maxDepth?: number;
  readonly maxDirs?: number;
}

/** A real directory (not a link to one) at `p`; any error is "no". */
function isRealDirectory(fs: ObsidianDiscoveryFs, p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every Obsidian vault under `roots` that a sandbox write grant may consider, in walk order, each
 * spelled as its root was given plus the real directory names below it. Ported from the
 * connector's 0.5.0 `walkForVaults`:
 *  - a configured root that is itself a link is followed (`stat`): it is the owner's configured
 *    path, and the connector follows it too;
 *  - every link BELOW a root is skipped (`lstat`), so a vault reached through a symlink or a
 *    junction is never found, inside the roots or out of them;
 *  - a vault needs a `.obsidian` DIRECTORY that is not a link (the connector accepts any entry with
 *    that name);
 *  - the connector's ignore list; depth ({@link OBSIDIAN_GRANT_DISCOVERY_MAX_DEPTH}) and a shared
 *    directory budget ({@link OBSIDIAN_GRANT_DISCOVERY_MAX_DIRS}) bound the walk.
 * An unreadable directory is skipped silently.
 */
export function discoverVaultsForWriteGrant(
  roots: readonly string[],
  options: ObsidianGrantDiscoveryOptions = {},
): readonly string[] {
  const fs = options.fs ?? NODE_DISCOVERY_FS;
  const maxDepth = options.maxDepth ?? OBSIDIAN_GRANT_DISCOVERY_MAX_DEPTH;
  const budget = { left: options.maxDirs ?? OBSIDIAN_GRANT_DISCOVERY_MAX_DIRS };
  const out: string[] = [];
  for (const root of roots) {
    let rootIsDir = false;
    try {
      rootIsDir = fs.statSync(root).isDirectory();
    } catch {
      continue;
    }
    if (rootIsDir) walkForGrant(fs, root, 0, maxDepth, budget, out);
  }
  return out;
}

function walkForGrant(
  fs: ObsidianDiscoveryFs,
  dir: string,
  depth: number,
  maxDepth: number,
  budget: { left: number },
  out: string[],
): void {
  if (budget.left <= 0) return;
  budget.left -= 1;
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (entries.includes(VAULT_MARKER) && isRealDirectory(fs, join(dir, VAULT_MARKER))) {
    out.push(dir);
  }
  if (depth >= maxDepth) return;
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) continue;
    const sub = join(dir, e);
    if (isRealDirectory(fs, sub)) walkForGrant(fs, sub, depth + 1, maxDepth, budget, out);
  }
}
