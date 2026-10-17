import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { isSameOrInside } from "../util/path-overlap.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import type { VerifiedExtensionForSpawn } from "./verified-extension.ts";

/**
 * A verified extension whose code has been copied into a fresh per-spawn stage and re-digested.
 * The spawn runs `entryPath`, which lies inside `stagePath`, with `stagePath` as its working
 * directory; the install tree is not granted at all.
 */
export interface StagedExtensionForSpawn extends VerifiedExtensionForSpawn {
  /**
   * `<sandboxDir>/ext-stage/<serviceId>/<uuid>`: a directory created for THIS spawn, whose tree
   * digest equals `treeDigest`, and the child's working directory.
   */
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
    // Left for the next spawn's sweep, or for `extension remove` / `revoke`, which delete the
    // extension's whole stage root.
  }
}

/**
 * Best effort: delete EVERYTHING already in the extension's stage root before a new stage is made —
 * earlier stages, and anything else that appeared there (the root is gateway-owned, so nothing in
 * it is kept). A still-exiting Windows child may hold a file in its own old stage; that stage is
 * left for the next sweep, and is a sibling of the new stage, never on its path.
 */
function sweepStageRoot(stageRoot: string): void {
  let names: string[];
  try {
    names = readdirSync(stageRoot);
  } catch {
    return;
  }
  for (const name of names) removeBestEffort(join(stageRoot, name));
}

function refuseTreeChanged(v: VerifiedExtensionForSpawn, why: string): never {
  throw new ExtensionRunGrantError(
    "ERR_EXTENSION_RUN_TREE_CHANGED",
    `${v.extensionId}'s files changed while they were staged to run (${why}); review them, run \`nimbus extension rehash ${v.extensionId}\` and approve it again`,
  );
}

/**
 * Stage a VERIFIED extension for one spawn: copy its install tree into a fresh
 * `<stageRoot>/<uuid>`, re-digest the COPY and require it to equal the digest the verifier just
 * computed, then point the entry into the copy. The stage is also the child's working directory.
 *
 * Why a copy at all: on Windows, Bun's module loader opens every module file it loads asking for
 * FILE_WRITE_ATTRIBUTES, which a read-only AppContainer grant does not carry, so an extension
 * cannot `import()` its own code from a read-only install tree (measured; `docs/sandbox.md`). The
 * sandbox grants a spawn's working directory read-write on every platform, so a copy that IS the
 * working directory needs no new right, and the install tree drops out of the grant entirely.
 *
 * Why a FRESH directory per spawn, outside every per-policy leaf: Bun honours `bunfig.toml`
 * (`preload`), `.env` and `node_modules` found in the working directory, none of which the digest
 * covers. A long-lived cwd would let a previous run of the extension, or any same-user process,
 * plant code that runs before the approved entry and survives a revoke and re-approval. A fresh
 * stage holds only digested files, and its ancestors (`<stageRoot>`, `ext-stage`, the sandbox
 * root) are gateway-owned and granted to no spawn. One code path on all three platforms.
 */
export function stageVerifiedExtension(
  v: VerifiedExtensionForSpawn,
  stageRoot: string,
  deps: ExtensionStageDeps = {},
): StagedExtensionForSpawn {
  const copyTree = deps.copyTree ?? copyRegularTree;
  const digest = deps.treeDigest ?? computeExtensionTreeDigest;
  mkdirSync(stageRoot, { recursive: true });
  sweepStageRoot(stageRoot);
  const stagePath = join(stageRoot, randomUUID());
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
