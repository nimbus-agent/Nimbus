// packages/gateway/src/connectors/connector-writes/iac-git-scan.ts
// A bounded walk for a `.git` entry beneath an IaC working directory (Phase 9.7 D2, owner ruling
// OR-D2-8). A Terraform plan or apply child writes the whole working directory, so a repository
// anywhere beneath it would let that child plant `.git/hooks/*` (or a `.git` file pointing at a hooks
// directory elsewhere) that the owner's own git runs later. The directory is therefore refused at
// `enable iac` and at every gate, with a fixed reason; this module only answers the question.
//
// The walk never follows a link (a link is not descended, and one NAMED `.git` is itself a hit), is
// capped in depth and in entries, and FAILS CLOSED: a directory it cannot read, or a tree larger than
// the caps, is not "clean".
import { type Dirent, readdirSync } from "node:fs";
import { join, sep } from "node:path";

export const IAC_GIT_SCAN_LIMITS = Object.freeze({
  /** Directory levels below the working directory that are read (the working directory is level 0). */
  maxDepth: 16,
  /** Directory entries examined in total. */
  maxEntries: 50_000,
});

/**
 * `clean` is the only answer that lets a directory through. `module`: the only `.git` entries are
 * under the working directory's own `.terraform/modules/` (a git-sourced module `terraform init`
 * cloned), refused with its own text (connectors 0.21.0); any other `.git` is `found`.
 */
export type GitScan = "clean" | "found" | "module" | "over-cap" | "unreadable";

/** The directory reader, injectable so the caps and the failure paths are testable without a huge tree. */
export type ReadDirEntries = (dir: string) => readonly Dirent[];

const readEntries: ReadDirEntries = (dir) => readdirSync(dir, { withFileTypes: true });

/**
 * Looks for an entry named `.git` (a folder, or a file as a submodule or worktree has; any letter
 * case, because a case-insensitive filesystem treats `.GIT` as the same entry) at any depth below
 * `root`.
 */
export function scanForGitEntry(
  root: string,
  limits: { readonly maxDepth: number; readonly maxEntries: number } = IAC_GIT_SCAN_LIMITS,
  read: ReadDirEntries = readEntries,
): GitScan {
  const counter = { examined: 0, modules: false };
  const modulesDir = join(root, ".terraform", "modules").toLowerCase();
  let level: string[] = [root];
  let depth = 0;
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      const inModules = isWithin(dir.toLowerCase(), modulesDir);
      const verdict = scanDirectory(dir, next, counter, limits.maxEntries, read, inModules);
      if (verdict !== "clean") return verdict;
    }
    if (next.length > 0 && depth + 1 > limits.maxDepth) return "over-cap";
    level = next;
    depth += 1;
  }
  return counter.modules ? "module" : "clean";
}

/** Is `dir` strictly inside `parent` (both lower-cased, so `.Terraform/Modules` counts too)? */
function isWithin(dir: string, parent: string): boolean {
  return dir.startsWith(`${parent}${sep}`) || dir.startsWith(`${parent}/`);
}

/** One directory: a verdict other than `clean` ends the scan; real subfolders are queued in `next`. */
function scanDirectory(
  dir: string,
  next: string[],
  counter: { examined: number; modules: boolean },
  maxEntries: number,
  read: ReadDirEntries,
  inModules: boolean,
): GitScan {
  let entries: readonly Dirent[];
  try {
    entries = read(dir);
  } catch {
    return "unreadable";
  }
  for (const entry of entries) {
    counter.examined += 1;
    if (counter.examined > maxEntries) return "over-cap";
    if (entry.name.toLowerCase() === ".git") {
      // A module's clone is noted (never descended) and the walk goes on: any other `.git` wins.
      if (!inModules) return "found";
      counter.modules = true;
      continue;
    }
    // isDirectory() is false for a link (the entry is not followed), true only for a real folder.
    if (entry.isDirectory()) next.push(join(dir, entry.name));
  }
  return "clean";
}
