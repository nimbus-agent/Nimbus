// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-module-git.ts
// The `.git` folders a `terraform init` clones with a git-sourced module (owner ruling 2026-11-27;
// invariant I15, beside OR-D2-8; static D43(d)). `terraform init` clones such a module, with its
// `.git`, to `<workdir>/.terraform/modules/<key>/`. After a SUCCESSFUL init the runner removes
// exactly the `.git` directories THAT init created, one level under `modules/` and nowhere else,
// found by comparing a listing taken before the child started with one taken after it exited.
// OR-D2-8 is unchanged: the real `.git` scan runs again afterwards, and anything left (a `.git`
// elsewhere, a link, a file, a deeper one, one that existed before) keeps the dedicated refusal.
//
// A candidate is removed only when it is a real directory (not a link or a junction, not a file)
// AND the kernel's name for it is exactly `<workdir>/.terraform/modules/<key>/.git`, so no
// component of the path (`.terraform`, `modules`, `<key>`) is a link that leads out of the workdir.
// The workdir is the gateway-resolved canonical path. Every file under it is made writable before
// the removal (Windows marks git's pack and object files read-only); links inside are never
// followed, neither by that walk nor by the removal.
import { chmodSync, type Dirent, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The filesystem this module touches; production wires `node:fs`, tests inject. */
export interface ModuleGitFs {
  readonly readDir: (dir: string) => readonly Dirent[];
  /** `undefined` when nothing is there; never follows a link. */
  readonly lstatKind: (p: string) => "dir" | "link" | "other" | undefined;
  /** The kernel's view of the path; throws when it is missing. */
  readonly realpath: (p: string) => string;
  /** Makes a real file or directory writable (never called on a link). */
  readonly makeWritable: (p: string, isDir: boolean) => void;
  readonly removeTree: (p: string) => void;
}

const nodeModuleGitFs: ModuleGitFs = {
  readDir: (dir) => readdirSync(dir, { withFileTypes: true }),
  lstatKind: (p) => {
    try {
      const s = lstatSync(p);
      if (s.isSymbolicLink()) return "link";
      return s.isDirectory() ? "dir" : "other";
    } catch {
      return undefined;
    }
  },
  realpath: (p) => realpathSync.native(p),
  makeWritable: (p, isDir) => chmodSync(p, isDir ? 0o700 : 0o600),
  removeTree: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
};

/** What a removal pass did: the module keys whose `.git` it removed, and those it left (refused). */
export interface ModuleGitRemoval {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

function insensitive(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** A module key as a directory listing gives it: one plain path segment, nothing that climbs. */
function plainSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function modulesDir(workdir: string): string {
  return join(workdir, ".terraform", "modules");
}

/**
 * The module keys under `<workdir>/.terraform/modules/` that have a `.git` entry of any kind right
 * now (a missing or unreadable `modules/` lists none). Keys are lower-cased where the filesystem is
 * case-insensitive, so two spellings of one folder are one key.
 */
export function moduleGitKeys(
  workdir: string,
  platform: NodeJS.Platform,
  fs: ModuleGitFs = nodeModuleGitFs,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const { key } of moduleGitCandidates(workdir, fs)) {
    out.add(insensitive(platform) ? key.toLowerCase() : key);
  }
  return out;
}

/** Every `<key>/.git` under `modules/`, any letter case of `.git`, with the kind of the entry. */
function moduleGitCandidates(
  workdir: string,
  fs: ModuleGitFs,
): Array<{ key: string; path: string; kind: "dir" | "link" | "other" }> {
  const dir = modulesDir(workdir);
  let keys: readonly Dirent[];
  try {
    keys = fs.readDir(dir);
  } catch {
    return [];
  }
  const out: Array<{ key: string; path: string; kind: "dir" | "link" | "other" }> = [];
  for (const k of keys) {
    if (!plainSegment(k.name)) continue;
    let entries: readonly Dirent[];
    try {
      // A link named as a module is listed through, but its `.git` fails the realpath check below.
      entries = fs.readDir(join(dir, k.name));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.toLowerCase() !== ".git") continue;
      const path = join(dir, k.name, e.name);
      const kind = fs.lstatKind(path);
      if (kind !== undefined) out.push({ key: k.name, path, kind });
    }
  }
  return out;
}

/** Does the kernel name `p` exactly as written (so no component of it is a link)? */
function namedExactly(p: string, platform: NodeJS.Platform, fs: ModuleGitFs): boolean {
  let real: string;
  try {
    real = fs.realpath(p);
  } catch {
    return false;
  }
  return insensitive(platform) ? real.toLowerCase() === p.toLowerCase() : real === p;
}

/** Makes every real file and folder in a tree writable; a link is neither changed nor followed. */
function makeTreeWritable(dir: string, fs: ModuleGitFs): void {
  fs.makeWritable(dir, true);
  for (const e of fs.readDir(dir)) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) makeTreeWritable(p, fs);
    else fs.makeWritable(p, false);
  }
}

/** Did the init call succeed? A reply the connector marked `isError` is a failed init. */
export function initSucceeded(reply: unknown): boolean {
  return !(
    typeof reply === "object" &&
    reply !== null &&
    (reply as { isError?: unknown }).isError === true
  );
}

/**
 * After a SUCCESSFUL init: removes each `<workdir>/.terraform/modules/<key>/.git` that is not in
 * `before` (the {@link moduleGitKeys} taken before the init child started), that is a real
 * directory, and whose kernel path is exactly the one built from the canonical workdir. Anything
 * else is kept, for the caller's real `.git` rescan to refuse. Never throws: a removal that fails
 * leaves the folder, which the rescan refuses.
 */
export function removeInitModuleGits(
  workdir: string,
  before: ReadonlySet<string>,
  platform: NodeJS.Platform,
  fs: ModuleGitFs = nodeModuleGitFs,
): ModuleGitRemoval {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const c of moduleGitCandidates(workdir, fs)) {
    if (before.has(insensitive(platform) ? c.key.toLowerCase() : c.key)) {
      kept.push(c.key);
      continue;
    }
    if (c.kind !== "dir" || !namedExactly(c.path, platform, fs)) {
      kept.push(c.key);
      continue;
    }
    try {
      makeTreeWritable(c.path, fs);
      fs.removeTree(c.path);
      removed.push(c.key);
    } catch {
      kept.push(c.key);
    }
  }
  return { removed, kept };
}
