import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { isSameOrInside } from "../util/path-overlap.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import type { VerifiedExtensionForSpawn } from "./verified-extension.ts";

/** The prefix of every per-spawn stage directory inside an extension's sandbox leaf. */
export const EXTENSION_STAGE_PREFIX = "run-";

/**
 * A verified extension whose code has been copied into a per-spawn stage and re-digested. The
 * spawn runs `entryPath`, which lies inside `stagePath`; the install tree is not granted at all.
 */
export interface StagedExtensionForSpawn extends VerifiedExtensionForSpawn {
  /** `<leaf>/run-<uuid>`, a fresh directory whose tree digest equals `treeDigest`. */
  readonly stagePath: string;
}

export interface ExtensionStageDeps {
  /** Injected only so a test can tamper between copy and digest; defaults to {@link copyRegularTree}. */
  readonly copyTree?: (from: string, to: string) => void;
  /** Injected only for tests; defaults to {@link computeExtensionTreeDigest}. */
  readonly treeDigest?: (root: string) => string;
}

/**
 * Copies `from` into `to` (which must not exist), regular files and directories only. The install
 * tree holds nothing else — the tree digest refuses a symlink — so anything else found here means
 * the tree changed under us, and the copy refuses rather than reproducing it.
 */
export function copyRegularTree(from: string, to: string): void {
  mkdirSync(to);
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, ent.name);
    const dst = join(to, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      copyRegularTree(src, dst);
    } else if (ent.isFile() && lstatSync(src).isFile()) {
      copyFileSync(src, dst);
    } else {
      throw new Error(`extension tree holds a non-regular entry: ${src}`);
    }
  }
}

/** One removal attempt; a failure is swallowed (a still-exiting Windows child may hold a file). */
function removeBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Left for the next spawn's sweep, or for `extension remove`, which deletes the whole leaf.
  }
}

/** Best effort: delete every earlier `run-*` stage in the leaf before a new one is created. */
function sweepOldStages(leaf: string): void {
  let names: string[];
  try {
    names = readdirSync(leaf);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(EXTENSION_STAGE_PREFIX)) removeBestEffort(join(leaf, name));
  }
}

function refuseTreeChanged(v: VerifiedExtensionForSpawn, why: string): never {
  throw new ExtensionRunGrantError(
    "ERR_EXTENSION_RUN_TREE_CHANGED",
    `${v.extensionId}'s files changed while they were staged to run (${why}); review them, run \`nimbus extension rehash ${v.extensionId}\` and approve it again`,
  );
}

/**
 * Stage a VERIFIED extension for one spawn: copy its install tree into `<leaf>/run-<uuid>`,
 * re-digest the COPY and require it to equal the digest the verifier just computed, then point the
 * entry into the copy.
 *
 * Why a copy at all: on Windows, Bun's module loader opens every module file it loads asking for
 * FILE_WRITE_ATTRIBUTES, which a read-only AppContainer grant does not carry, so an extension
 * cannot `import()` its own code from a read-only install tree (measured; `docs/sandbox.md`). The
 * leaf is already the extension's own writable working directory on every platform, so running
 * from a copy there needs no new right, and the install tree drops out of the grant entirely. One
 * code path on all three platforms.
 */
export function stageVerifiedExtension(
  v: VerifiedExtensionForSpawn,
  leaf: string,
  deps: ExtensionStageDeps = {},
): StagedExtensionForSpawn {
  const copyTree = deps.copyTree ?? copyRegularTree;
  const digest = deps.treeDigest ?? computeExtensionTreeDigest;
  mkdirSync(leaf, { recursive: true });
  sweepOldStages(leaf);
  const stagePath = join(leaf, `${EXTENSION_STAGE_PREFIX}${randomUUID()}`);
  let staged: string | null;
  try {
    copyTree(v.installPath, stagePath);
    staged = digest(stagePath);
  } catch {
    staged = null;
  }
  if (staged !== v.treeDigest) {
    removeBestEffort(stagePath);
    refuseTreeChanged(v, staged === null ? "the copy could not be made" : "the copy differs");
  }
  const entryRel = relative(v.installPath, v.entryPath);
  const entryPath = join(stagePath, entryRel);
  if (
    !isSameOrInside(process.platform, entryPath, stagePath) ||
    isSameOrInside(process.platform, stagePath, entryPath)
  ) {
    removeBestEffort(stagePath);
    throw new ExtensionRunGrantError(
      "ERR_EXTENSION_ENTRY_OUTSIDE",
      `${v.extensionId}'s entry "${entryPath}" lies outside its stage "${stagePath}"`,
    );
  }
  return { ...v, stagePath, entryPath };
}
