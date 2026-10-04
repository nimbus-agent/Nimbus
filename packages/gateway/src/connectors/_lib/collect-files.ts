import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Bounds and file filter for {@link collectFiles}. */
export interface CollectFilesOptions {
  /** The deepest directory level read; `root` itself is level 0. */
  readonly maxDepth: number;
  /** The walk stops once this many files have been collected. */
  readonly maxFiles: number;
  /** Whether a regular file is collected, judged by its base name. */
  readonly accept: (fileName: string) => boolean;
}

/**
 * Bounded depth-first walk of `root` for the local-files syncables: the full paths of the accepted
 * regular files, in directory-listing order. An unreadable directory (the root included) is
 * skipped, never fatal.
 */
export async function collectFiles(root: string, options: CollectFilesOptions): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || found.length >= options.maxFiles) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (found.length >= options.maxFiles) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1); // NOSONAR S9382: depth-first walk sharing the maxFiles cap - each entry's early exit reads `found` as the previous subtree left it
      } else if (entry.isFile() && options.accept(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}
