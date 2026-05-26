#!/usr/bin/env bun
/**
 * Narrow v1 cross-platform audit: flags **Windows-separator** path literals
 * (backslash / drive-letter / UNC) inside test assertions. A Windows path
 * hardcoded in a test is the canonical "passes on my Windows machine, fails on
 * the Ubuntu PR gate" footgun — build paths with path.join()/os.tmpdir() instead.
 *
 * SCOPE — Windows separators only, on purpose. POSIX forward-slash absolute
 * strings (`/tmp/...`, `/home/...`) are intentionally NOT flagged: in this
 * codebase they are overwhelmingly legitimate *data values* (socket-path
 * fixtures, env-var pass-throughs like KUBECONFIG/PATH, HTTP/API URL routes,
 * router routes) that a regex provably cannot distinguish from a constructed
 * path — an empirical first pass produced 52 false positives and 0 real bugs.
 * Backslash separators have no such collision (they never appear in URLs/routes/
 * POSIX fixtures), so this scope is high-precision. Detecting POSIX-absolute
 * hardcoding reliably needs data-flow analysis — that is the AST v2 escalation.
 *
 * Suppress a genuinely-intentional line with `// cross-platform-ok`.
 */
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { REPO_ROOT } from "../structure-audit/lib.ts";

export interface CrossPlatformIssue {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

// `toMatch` is intentionally excluded — it is overwhelmingly used with regexes /
// substrings, the largest false-positive source. Add it back only behind AST v2.
const ASSERTION_RE = /\.(toBe|toEqual|toStrictEqual|toContain)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

function looksLikeWindowsPath(literal: string): boolean {
  // `literal` is the raw source between the quotes; a Windows separator is
  // written `\\` in source, so collapse escaped pairs to single backslashes.
  const s = literal.replace(/\\\\/g, "\\");
  if (!s.includes("\\")) return false; // no backslash → not a Windows-separator path
  if (/^[A-Za-z]:\\/.test(s)) return true; // drive-letter absolute: C:\...
  if (/^\\\\[^\\]/.test(s)) return true; // UNC: \\server\share
  if (/^\.\.?\\/.test(s)) return true; // explicit relative: .\x or ..\x
  if (/\\[\w.-]+\.[A-Za-z0-9]{1,6}(?:$|["'`])/.test(s)) return true; // ...\file.ext
  return false;
}

export function findCrossPlatformIssues(source: string, file: string): CrossPlatformIssue[] {
  const issues: CrossPlatformIssue[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("// cross-platform-ok")) continue;
    ASSERTION_RE.lastIndex = 0;
    for (const m of line.matchAll(ASSERTION_RE)) {
      const literal = m[3] ?? "";
      if (looksLikeWindowsPath(literal)) {
        issues.push({ file, line: i + 1, text: literal });
      }
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const all: CrossPlatformIssue[] = [];
  const glob = new Glob("packages/**/*.test.{ts,tsx}");
  for await (const rel of glob.scan({ cwd: REPO_ROOT })) {
    const abs = `${REPO_ROOT}/${rel}`;
    for (const issue of findCrossPlatformIssues(
      readFileSync(abs, "utf8"),
      rel.replaceAll("\\", "/"),
    )) {
      all.push(issue);
    }
  }
  if (all.length === 0) {
    console.log(
      "cross-platform audit: no hardcoded Windows-separator path assertions in test files.",
    );
    return;
  }
  for (const i of all) {
    console.error(
      `::error file=${i.file},line=${i.line}::hardcoded Windows path separator in assertion: "${i.text}" — use path.join()/os.tmpdir(), or add \`// cross-platform-ok\` if intentional`,
    );
  }
  console.error(`\n${all.length} cross-platform issue(s).`);
  process.exit(1);
}

if (import.meta.main) await main();
