#!/usr/bin/env bun
/**
 * Split-folder privacy (owner ruling 2026-11-23, after the 500-line campaign).
 *
 * A big file `X.ts` is split into a thin facade `X.ts` plus a folder `X/` of modules. TypeScript has
 * no cross-file private, so a function that was module-private inside `X.ts` had to be EXPORTED from
 * its new module to be reached. Without a rule, any other module can import it and skip the checks
 * `X.ts` ran first (`installApprovedPlan` skipping the owner's consent, `runDeploymentRoute` skipping
 * `dispatchWriteRoute`'s auth and rate limit). The rule restores the pre-split privacy:
 *
 *   A module inside a split folder is imported only by (1) its facade, (2) other modules inside the
 *   same folder, (3) test files (`*.test.ts(x)` and anything under a `test/` directory).
 *   Everyone else goes through the facade, which re-exports exactly what was public before the split.
 *
 * Pairs are DERIVED: a folder `D/` with a sibling `D.ts` (or `D.tsx`). Facades that are not siblings
 * are in {@link EXPLICIT_PAIRS}. Derived folders that are not splits are listed by exact path in
 * {@link EXEMPT_FOLDERS}, each with its reason; there is no glob or prefix exemption.
 *
 * Decision on `import type` / `export type ... from`: ALLOWED. A type is erased at build time and
 * cannot execute, so it cannot skip a check; refusing it would only force types through the facade
 * for no gain. An inline `import { type X }` still counts as a value import (verbatimModuleSyntax
 * keeps the module import), so it is refused.
 *
 * Matched spellings: relative `./x/y` and `../x/y`, with or without `.ts`/`.tsx`/`.js`, in `import`,
 * side-effect `import "..."`, `export ... from`, dynamic `import("...")` and `require("...")`. A
 * non-relative specifier is not resolved (no path alias reaches into a split folder).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceFile {
  readonly path: string;
  readonly contents: string;
}

export interface SplitPair {
  /** Repo-relative folder, no trailing slash. */
  readonly dir: string;
  /** Repo-relative path of the facade file. */
  readonly facade: string;
}

export interface Violation {
  readonly importer: string;
  readonly line: number;
  readonly specifier: string;
  readonly target: string;
  readonly facade: string;
}

/** Facades that are not a sibling `D.ts` of their folder `D/`. */
export const EXPLICIT_PAIRS: readonly SplitPair[] = [
  {
    dir: "packages/gateway/src/agents/_lib/negotiate",
    facade: "packages/gateway/src/agents/negotiate.ts",
  },
  {
    dir: "scripts/structure-audit/invariants",
    facade: "scripts/structure-audit/check-nimbus-invariants.ts",
  },
];

/** Derived `D.ts` + `D/` pairs that are NOT splits, by exact folder path, each with its reason. */
export const EXEMPT_FOLDERS: Readonly<Record<string, string>> = {
  "packages/gateway/src/config":
    "pre-existing module folder (114 files) beside an unrelated 110-line config.ts; never a split of it",
  "packages/gateway/src/index":
    "pre-existing module folder (the local index) beside the gateway executable entry index.ts; never a split of it",
};

const SOURCE_FILE = /\.(?:ts|tsx)$/;
const DECLARATION_FILE = /\.d\.ts$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || path.split("/").includes("test");
}

function stripExtension(path: string): string {
  return path.replace(/\.(?:ts|tsx|js|mjs)$/, "");
}

/** Pairs derived from the file list (folder D with a sibling D.ts or D.tsx) plus the explicit ones. */
export function derivePairs(paths: readonly string[]): SplitPair[] {
  const set = new Set(paths);
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const pairs = new Map<string, SplitPair>();
  for (const dir of [...dirs].sort()) {
    if (Object.hasOwn(EXEMPT_FOLDERS, dir)) continue;
    for (const ext of [".ts", ".tsx"]) {
      if (set.has(dir + ext)) pairs.set(dir, { dir, facade: dir + ext });
    }
  }
  for (const e of EXPLICIT_PAIRS) pairs.set(e.dir, e);
  return [...pairs.values()];
}

/** Table entries that no longer match the tree: a stale row would silently stop enforcing. */
export function staleTableEntries(paths: readonly string[]): string[] {
  const set = new Set(paths);
  const out: string[] = [];
  for (const e of EXPLICIT_PAIRS) {
    if (!set.has(e.facade)) out.push(`EXPLICIT_PAIRS facade ${e.facade} does not exist`);
    if (!paths.some((p) => p.startsWith(`${e.dir}/`))) {
      out.push(`EXPLICIT_PAIRS folder ${e.dir} holds no source file`);
    }
  }
  for (const dir of Object.keys(EXEMPT_FOLDERS)) {
    if (!set.has(`${dir}.ts`) && !set.has(`${dir}.tsx`)) {
      out.push(`EXEMPT_FOLDERS ${dir} has no sibling facade any more; delete the exemption`);
    }
  }
  return out;
}

interface Specifier {
  readonly specifier: string;
  readonly line: number;
  readonly typeOnly: boolean;
}

const SPECIFIER_AT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*)\1/g;

/** Where the statement that owns a `from` clause begins: the last import/export keyword before it. */
function statementStart(text: string, at: number): number {
  const head = text.slice(Math.max(0, at - 4000), at);
  const re = /\b(?:import|export)\b/g;
  let last = -1;
  for (let m = re.exec(head); m !== null; m = re.exec(head)) last = m.index;
  return last === -1 ? at : at - head.length + last;
}

export function findRelativeSpecifiers(text: string): Specifier[] {
  const out: Specifier[] = [];
  SPECIFIER_AT.lastIndex = 0;
  for (let m = SPECIFIER_AT.exec(text); m !== null; m = SPECIFIER_AT.exec(text)) {
    const specifier = m[2] ?? "";
    const matchText = m[0];
    const isFrom = /^from/.test(matchText);
    let typeOnly = false;
    if (isFrom) {
      const start = statementStart(text, m.index);
      typeOnly = /^(?:import|export)\s+type\b(?!\s*,)/.test(text.slice(start, m.index));
    }
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ specifier, line, typeOnly });
  }
  return out;
}

function resolveRelative(importer: string, specifier: string): string {
  const parts = importer.split("/").slice(0, -1);
  for (const seg of specifier.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return stripExtension(parts.join("/"));
}

export function findViolations(files: readonly SourceFile[]): Violation[] {
  const pairs = derivePairs(files.map((f) => f.path));
  const out: Violation[] = [];
  for (const file of files) {
    if (isTestFile(file.path) || DECLARATION_FILE.test(file.path)) continue;
    for (const s of findRelativeSpecifiers(file.contents)) {
      if (s.typeOnly) continue;
      const target = resolveRelative(file.path, s.specifier);
      for (const pair of pairs) {
        if (!target.startsWith(`${pair.dir}/`)) continue;
        if (file.path === pair.facade || file.path.startsWith(`${pair.dir}/`)) continue;
        out.push({
          importer: file.path,
          line: s.line,
          specifier: s.specifier,
          target,
          facade: pair.facade,
        });
      }
    }
  }
  return out;
}

const REPO_ROOT = join(import.meta.dir, "..", "..");

function loadFiles(): SourceFile[] {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "packages",
      "scripts",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const out: SourceFile[] = [];
  for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
    if (!SOURCE_FILE.test(path)) continue;
    try {
      out.push({ path, contents: readFileSync(join(REPO_ROOT, path), "utf8") });
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") continue;
      throw err;
    }
  }
  return out;
}

function main(): number {
  const files = loadFiles();
  const stale = staleTableEntries(files.map((f) => f.path));
  for (const s of stale) console.error(`::error::split-folder-privacy: ${s}`);
  const violations = findViolations(files);
  for (const v of violations) {
    console.error(
      `::error file=${v.importer},line=${String(v.line)}::split-folder-privacy: imports ${v.specifier}, a module inside a split folder. Import it through its facade ${v.facade} (re-export it there only if it was public before the split).`,
    );
  }
  const pairs = derivePairs(files.map((f) => f.path));
  console.log(
    `split-folder-privacy: ${String(pairs.length)} split folder(s), ${String(violations.length)} violation(s)`,
  );
  return stale.length + violations.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
