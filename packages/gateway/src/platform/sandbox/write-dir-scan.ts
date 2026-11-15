// packages/gateway/src/platform/sandbox/write-dir-scan.ts
// The tree rule for a directory a sandboxed child may WRITE beneath (I15, Phase 28 AD5b; owner
// rulings OR-AD-28 and OR-AD-29). A write grant reaches file OBJECTS, not names, so what already
// sits in the directory decides how far the grant goes:
//
//   - a link (symlink, junction) inside it leads somewhere else;
//   - a regular file with a second name (a hard link) is also a file outside the directory;
//   - a marker folder (`.git`, an editor's workspace folder, ...) holds code that the OWNER's own
//     tools run later, with the owner's rights.
//
// The walk never follows a link, is capped in depth and in entries, and FAILS CLOSED: only `clean`
// lets a directory through. It is a PAL module because the sandbox wrapper runs it at every real
// spawn and may not import from `connectors/`.
//
// Stated bounds: on Windows a reparse point that is neither a symlink nor a junction (a cloud
// placeholder, a mount point) reads as a plain file or directory here; and a tree that is clean now
// can be changed by the child once it runs (the next spawn is then refused).
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const WRITE_DIR_SCAN_LIMITS = Object.freeze({
  /** Directory levels below the granted directory that are read (the directory itself is level 0). */
  maxDepth: 16,
  /** Directory entries examined in total. */
  maxEntries: 50_000,
});

/**
 * Entry names whose folder is executed or trusted by the owner's own tools when they open the
 * directory. Compared in lower case, because a case-insensitive file system treats `.GIT` as `.git`.
 */
export const WRITE_DIR_MARKER_NAMES: readonly string[] = Object.freeze([
  ".git",
  ".obsidian",
  ".vscode",
  ".idea",
  ".husky",
  ".devcontainer",
  ".terraform",
]);

const MARKERS: ReadonlySet<string> = new Set(WRITE_DIR_MARKER_NAMES);

/** True for an entry name that is a marker, in any letter case. */
export function isWriteDirMarkerName(name: string): boolean {
  return MARKERS.has(name.toLowerCase());
}

/** `clean` is the only answer that lets a directory through. */
export type WriteDirScan =
  | "clean"
  | "marker"
  | "link"
  | "multi-link"
  | "special"
  | "over-cap"
  | "unreadable";

/** What the scan needs of an `lstat` of one entry (never followed). */
export interface WriteDirEntryKind {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly nlink: number;
}

/** The file-system reads, injectable so the caps and the failure paths need no huge tree. */
export interface WriteDirScanDeps {
  /** The entry names of one directory. */
  readonly readNames?: (dir: string) => readonly string[];
  /** `lstat` of one entry: it must not follow a link. */
  readonly lstat?: (path: string) => WriteDirEntryKind;
  readonly limits?: { readonly maxDepth: number; readonly maxEntries: number };
}

/**
 * Walks `root` breadth first and answers with the first thing that makes it unsafe to grant, or
 * `clean`. The caller has already established that `root` itself is a real directory.
 */
export function scanWriteDir(root: string, deps: WriteDirScanDeps = {}): WriteDirScan {
  const readNames = deps.readNames ?? ((dir: string) => readdirSync(dir));
  const lstat = deps.lstat ?? ((p: string) => lstatSync(p));
  const limits = deps.limits ?? WRITE_DIR_SCAN_LIMITS;
  const counter = { examined: 0 };
  let level: string[] = [root];
  let depth = 0;
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      const verdict = scanOneDirectory(dir, next, counter, limits.maxEntries, readNames, lstat);
      if (verdict !== "clean") return verdict;
    }
    if (next.length > 0 && depth + 1 > limits.maxDepth) return "over-cap";
    level = next;
    depth += 1;
  }
  return "clean";
}

/** One directory: a verdict other than `clean` ends the scan; real subfolders are queued in `next`. */
function scanOneDirectory(
  dir: string,
  next: string[],
  counter: { examined: number },
  maxEntries: number,
  readNames: (dir: string) => readonly string[],
  lstat: (path: string) => WriteDirEntryKind,
): WriteDirScan {
  let names: readonly string[];
  try {
    names = readNames(dir);
  } catch {
    return "unreadable";
  }
  for (const name of names) {
    counter.examined += 1;
    if (counter.examined > maxEntries) return "over-cap";
    // The name first: a marker is refused whatever it is (a folder, a file, a link).
    if (isWriteDirMarkerName(name)) return "marker";
    const path = join(dir, name);
    const verdict = classifyEntry(path, lstat);
    if (verdict === "directory") next.push(path);
    else if (verdict !== "file") return verdict;
  }
  return "clean";
}

function classifyEntry(
  path: string,
  lstat: (path: string) => WriteDirEntryKind,
): "directory" | "file" | "link" | "multi-link" | "special" | "unreadable" {
  let st: WriteDirEntryKind;
  try {
    st = lstat(path);
  } catch {
    return "unreadable";
  }
  // The link test first: a link is never descended and never counted as what it points at.
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "directory";
  if (!st.isFile()) return "special";
  return st.nlink === 1 ? "file" : "multi-link";
}
