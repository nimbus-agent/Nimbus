#!/usr/bin/env bun
/**
 * Narrow v1 cross-platform audit: flags filesystem-path string literals with an
 * explicit separator inside test assertions, which break on the other OS unless
 * built with path.join()/os.tmpdir(). Suppress a line with `// cross-platform-ok`.
 * v2 (if noisy): replace the regex with an AST-based check. See the design spec.
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
// substrings, the largest false-positive source (review Q2). Add it back only
// behind the AST v2 rewrite.
const ASSERTION_RE = /\.(toBe|toEqual|toStrictEqual|toContain)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

function looksLikePathWithSeparator(literal: string): boolean {
  const s = literal.replace(/\\\\/g, "\\"); // collapse escaped backslashes
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false; // URL scheme (http://, file://)
  if (!/[\\/]/.test(s)) return false; // no separator at all
  // Triage-narrowing (review Q2): drop the largest false-positive *shape* classes
  // that a regex can rule out with certainty, so the escape hatch is reserved for
  // genuine-shaped absolute roots. NOT weakened against `/tmp`-style roots — those
  // stay caught by the absolute/drive/UNC rule below.
  if (/^\s*#/.test(s)) return false; // markdown heading, e.g. "# Impact: src/x.ts"
  if (/\s/.test(s)) return false; // embedded whitespace → a sentence/log line, not a bare path literal
  if (/^[A-Za-z]{2,}[\w.-]*:/.test(s)) return false; // logical "<scope>:<rest>" id (filesystem:, obsidian:); a 1-char prefix is a Windows drive and is kept
  if (/^(\/[^/]|[A-Za-z]:\\|\.\.?[\\/]|\\\\)/.test(s)) return true; // absolute / drive / rel-with-dot / UNC
  if (/\\[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(s)) return true; // backslash .../file.ext (Windows separator — never a URL or repo-relative id)
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
      if (looksLikePathWithSeparator(literal)) {
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
    console.log("cross-platform audit: no hardcoded-separator path assertions in test files.");
    return;
  }
  for (const i of all) {
    console.error(
      `::error file=${i.file},line=${i.line}::hardcoded path separator in assertion: "${i.text}" — use path.join()/os.tmpdir(), or add \`// cross-platform-ok\` if intentional`,
    );
  }
  console.error(`\n${all.length} cross-platform issue(s).`);
  process.exit(1);
}

if (import.meta.main) await main();
