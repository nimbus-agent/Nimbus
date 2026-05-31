// scripts/cleanup/lib.ts
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Resolve relative to this file (scripts/cleanup/lib.ts), not the invocation cwd,
// so the survey scripts produce identical output regardless of where they are run from.
// Matches scripts/lib/root.ts and scripts/structure-audit/lib.ts.
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "build",
  "coverage",
  ".git",
  ".worktrees",
  ".turbo",
  "target",
  "out",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".rs"]);

export async function* iterateSourceFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* iterateSourceFiles(full);
    } else if (entry.isFile()) {
      const dotIdx = entry.name.lastIndexOf(".");
      if (dotIdx > 0 && SOURCE_EXTS.has(entry.name.slice(dotIdx))) {
        yield full;
      }
    }
  }
}

export function relPath(p: string): string {
  return relative(REPO_ROOT, p).replaceAll("\\", "/");
}

export interface CommentHit {
  file: string;
  line: number;
  text: string;
  marker: string;
}
