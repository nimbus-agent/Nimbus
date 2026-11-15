// packages/gateway/src/platform/sandbox/write-grant-check.ts
// What the sandbox wrapper checks about a policy's write DIRECTORIES before it creates a runner
// (I15; Phase 28 AD5b). It runs after the wrapper's two older checks (a canonicalised write path
// still canonicalises to itself; a declared file is still one regular file), in this order:
//
//   1. a path the gateway declared a DIRECTORY must still be a real directory, not a link;
//   2. that directory's tree must pass the tree rule (no link, no multiply-linked file, no marker).
//
// A refusal is a fixed sentence naming the path; the wrapper prints it and exits before any runner
// exists, so nothing is spawned and nothing is granted.
import { lstatSync } from "node:fs";

import { type DirKind, type SandboxPolicy, writeDirDrift } from "./sandbox-policy.ts";
import { scanWriteDir, type WriteDirScan } from "./write-dir-scan.ts";

export interface WriteDirGrantCheckDeps {
  readonly lstat?: (p: string) => DirKind;
  readonly scan?: (dir: string) => WriteDirScan;
}

/** Why each tree verdict refuses, in the words the owner reads in the connector's health record. */
export const WRITE_DIR_SCAN_REASONS: Readonly<Record<Exclude<WriteDirScan, "clean">, string>> =
  Object.freeze({
    marker: "holds a .git, editor or other marker folder",
    link: "holds a link",
    "multi-link": "holds a file that has a second name (a hard link)",
    special: "holds an entry that is neither a file nor a folder",
    "over-cap": "is too large or too deep to check",
    unreadable: "could not be read",
  });

/** The first reason this policy's write directories may not be granted now, or `undefined`. */
export function writeDirGrantRefusal(
  policy: SandboxPolicy,
  deps: WriteDirGrantCheckDeps = {},
): string | undefined {
  const dirs = policy.canonicalWriteDirs ?? [];
  if (dirs.length === 0) return undefined;
  const notADir = writeDirDrift(policy, deps.lstat ?? ((p: string) => lstatSync(p)));
  if (notADir !== undefined) {
    return `refusing to spawn: the write grant ${notADir} is no longer a real directory`;
  }
  const scan = deps.scan ?? ((dir: string) => scanWriteDir(dir));
  for (const dir of dirs) {
    const verdict = scan(dir);
    if (verdict !== "clean") {
      return `refusing to spawn: the write grant ${dir} ${WRITE_DIR_SCAN_REASONS[verdict]}`;
    }
  }
  return undefined;
}
