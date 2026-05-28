import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type DiscoveryOptions = {
  maxWalkDepth: number;
  ignoreGlobs: readonly string[];
};

const DEFAULT_IGNORE_DIRS = new Set([
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

const SPEC_FILENAME_RE = /^(openapi|swagger|asyncapi)\.(ya?ml|json)$/i;

function pathMatchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (matchesGlob(rel.replaceAll("\\", "/"), g)) {
      return true;
    }
  }
  return false;
}

function matchesGlob(input: string, glob: string): boolean {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === undefined) {
      continue;
    }
    const next: string | undefined = glob[i + 1];
    if (ch === "*" && next === "*") {
      re += ".*";
      i++;
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (/[a-zA-Z0-9_\-/]/.test(ch)) {
      re += ch;
    } else {
      re += `\\${ch}`;
    }
  }
  re += "$";
  return new RegExp(re).test(input);
}

export function discoverSpecFiles(root: string, opts: DiscoveryOptions): readonly string[] {
  const out: string[] = [];
  walk(root, root, 0, opts, out);
  return out;
}

function walk(
  root: string,
  dir: string,
  depth: number,
  opts: DiscoveryOptions,
  out: string[],
): void {
  if (depth > opts.maxWalkDepth) {
    return;
  }
  let entries: readonly {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      continue;
    }
    const abs = join(dir, e.name);
    const rel = abs.slice(root.length + 1);
    if (e.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(e.name)) {
        continue;
      }
      if (pathMatchesAnyGlob(rel, opts.ignoreGlobs)) {
        continue;
      }
      walk(root, abs, depth + 1, opts, out);
      continue;
    }
    if (!e.isFile()) {
      continue;
    }
    if (!SPEC_FILENAME_RE.test(basename(abs))) {
      continue;
    }
    if (pathMatchesAnyGlob(rel, opts.ignoreGlobs)) {
      continue;
    }
    try {
      if (statSync(abs).isFile()) {
        out.push(abs);
      }
    } catch {
      // ignore — file disappeared between readdir and stat
    }
  }
}
