import { readFile, writeFile } from "node:fs/promises";
// TypeScript 7 is the native port: its `typescript` package exports only lib/version.cjs at
// the root, and the compiler API moved to the explicitly UNSTABLE `typescript/unstable/*`
// subpaths. This script drives the compiler API directly, so it resolves a pinned TypeScript 6
// through the `typescript-compiler-api` alias rather than build repo tooling on an API its own
// maintainers label unstable. Everything else in the repo typechecks with 7.
import ts from "typescript-compiler-api";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";
import { loadInvariantCitedFiles, protectionFor } from "./protected-comments.ts";

// Machine-read directives. A comment is data when a tool parses it, so stripping one
// changes behaviour rather than tidying prose. Rationale per entry: scripts/cleanup/README.md.
const PRESERVE_PRAGMAS = [
  // TypeScript
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "<reference ",
  // Linters and formatters
  "biome-ignore",
  "eslint-disable",
  "oxlint-disable",
  "dprint-ignore",
  "prettier-ignore",
  // Static analysis this repo gates on
  "NOSONAR",
  "cross-platform-ok",
  "audit-ignore-next-line",
  // Coverage instrumentation
  "c8 ignore",
  "v8 ignore",
  "istanbul ignore",
  // Release and build tooling
  "x-release-please-version",
  "@license",
  "@preserve",
  "@__PURE__",
  "sourceMappingURL",
  // Test-runner docblocks
  "@vitest-environment",
  "@jest-environment",
];

// Literals whose interior is program data, not layout: collapsing blank runs inside one
// edits a runtime string. TemplateExpression is protected whole — its `${}` gaps need no
// collapsing, and covering the span is cheaper than tracking Head/Middle/Tail tokens.
const PROTECTED_LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/** Collapses 3+ newline runs to one blank line, skipping any run touching protected bytes. */
function collapseBlankRuns(text: string, isProtected: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "\n") {
      out.push(text[i] as string);
      i++;
      continue;
    }
    let j = i;
    let guarded = false;
    while (j < text.length && text[j] === "\n") {
      if (isProtected[j] === 1) guarded = true;
      j++;
    }
    out.push(j - i >= 3 && !guarded ? "\n\n" : text.slice(i, j));
    i = j;
  }
  return out.join("");
}

// Both published MIT packages (@nimbus-dev/sdk, @nimbus-dev/client) now live in
// their own repos; no monorepo-tree source ships as published JSDoc.
const PUBLISHED_JSDOC_PREFIXES: string[] = [];

export function shouldPreserveComment(text: string): boolean {
  return PRESERVE_PRAGMAS.some((p) => text.includes(p));
}

export function isPublishedJsdocFile(relativePath: string): boolean {
  return PUBLISHED_JSDOC_PREFIXES.some((p) => relativePath.startsWith(p));
}

function isJsdoc(text: string): boolean {
  return text.startsWith("/**");
}

export function stripTsSource(source: string, opts: { keepJsdoc: boolean }): string {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const removals: Array<{ start: number; end: number }> = [];
  const visitedScans = new Set<string>();
  const emittedStarts = new Set<number>();

  const isProtected = new Uint8Array(source.length);

  function scanCommentsAtPosition(pos: number, isLeading: boolean): void {
    const key = `${pos}:${isLeading ? "L" : "T"}`;
    if (visitedScans.has(key)) return;
    visitedScans.add(key);
    const ranges = isLeading
      ? ts.getLeadingCommentRanges(source, pos)
      : ts.getTrailingCommentRanges(source, pos);
    if (!ranges) return;
    for (const r of ranges) {
      if (emittedStarts.has(r.pos)) continue;
      const text = source.slice(r.pos, r.end);
      if (shouldPreserveComment(text)) {
        // A preserved block comment carries its own interior blank lines.
        for (let i = r.pos; i < r.end; i++) isProtected[i] = 1;
        continue;
      }
      if (opts.keepJsdoc && isJsdoc(text)) continue;
      const start = r.pos;
      let end = r.end;
      // Only a leading comment owns its line terminator. Eating a trailing comment's
      // newline welds the next statement onto this line.
      if (r.hasTrailingNewLine && isLeading) end = Math.min(source.length, end + 1);
      removals.push({ start, end });
      emittedStarts.add(r.pos);
    }
  }

  function walk(node: ts.Node): void {
    scanCommentsAtPosition(node.getFullStart(), true);
    scanCommentsAtPosition(node.getEnd(), false);
    if (PROTECTED_LITERAL_KINDS.has(node.kind)) {
      const end = node.getEnd();
      for (let i = node.getStart(sf); i < end; i++) isProtected[i] = 1;
    }
    node.forEachChild(walk);
  }
  walk(sf);

  removals.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of removals) {
    const last = merged.at(-1);
    if (last !== undefined && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  const pieces: string[] = [];
  const masks: Uint8Array[] = [];
  const keep = (start: number, end: number): void => {
    if (end <= start) return;
    pieces.push(source.slice(start, end));
    masks.push(isProtected.subarray(start, end));
  };
  let cursor = 0;
  for (const r of merged) {
    keep(cursor, r.start);
    cursor = Math.max(cursor, r.end);
  }
  keep(cursor, source.length);

  let out = pieces.join("");
  let outMask = new Uint8Array(out.length);
  let offset = 0;
  for (const m of masks) {
    outMask.set(m, offset);
    offset += m.length;
  }

  if (source.startsWith("#!") && !out.startsWith("#!")) {
    const nl = source.indexOf("\n");
    if (nl > 0) {
      const shebang = source.slice(0, nl + 1);
      out = shebang + out;
      const shifted = new Uint8Array(out.length);
      shifted.set(outMask, shebang.length);
      outMask = shifted;
    }
  }
  return collapseBlankRuns(out, outMask);
}

export function stripRustSource(source: string): { stripped: string; abstained: boolean } {
  const out: string[] = [];
  // Parallel to `out`: 1 marks a piece whose interior newlines are program data
  // (string, raw string, char literal) or a preserved pragma.
  const guarded: number[] = [];
  const emit = (text: string, isGuarded: boolean): void => {
    out.push(text);
    guarded.push(isGuarded ? 1 : 0);
  };
  let i = 0;
  let abstained = false;
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === undefined) break;

    if (c === "r" && (c2 === '"' || c2 === "#")) {
      let j = i + 1;
      let hashes = 0;
      while (j < source.length && source[j] === "#") {
        hashes++;
        j++;
      }
      if (j < source.length && source[j] === '"') {
        const terminator = `"${"#".repeat(hashes)}`;
        const end = source.indexOf(terminator, j + 1);
        if (end < 0) {
          abstained = true;
          break;
        }
        emit(source.slice(i, end + terminator.length), true);
        i = end + terminator.length;
        continue;
      }
    }

    if (c === '"') {
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      emit(source.slice(start, i), true);
      continue;
    }

    if (c === "'") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      if (source[i] === "'") i++;
      emit(source.slice(start, i), true);
      continue;
    }

    if (c === "/" && c2 === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i++;
      const text = source.slice(start, i);
      if (shouldPreserveComment(text)) emit(text, true);
      continue;
    }

    if (c === "/" && c2 === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        abstained = true;
        break;
      }
      const text = source.slice(i, end + 2);
      if (shouldPreserveComment(text)) emit(text, true);
      i = end + 2;
      continue;
    }

    emit(c, false);
    i++;
  }
  if (abstained) return { stripped: source, abstained: true };

  const text = out.join("");
  const isProtected = new Uint8Array(text.length);
  let offset = 0;
  for (let k = 0; k < out.length; k++) {
    const len = (out[k] as string).length;
    if (guarded[k] === 1) isProtected.fill(1, offset, offset + len);
    offset += len;
  }
  return { stripped: collapseBlankRuns(text, isProtected), abstained: false };
}

export async function stripFile(
  file: string,
): Promise<{ before: number; after: number; abstained?: boolean }> {
  const rel = relPath(file);
  if (rel.startsWith("scripts/cleanup/")) return { before: 0, after: 0 };
  const source = await readFile(file, "utf8");
  let next: string;
  let abstained = false;
  if (file.endsWith(".rs")) {
    const result = stripRustSource(source);
    next = result.stripped;
    abstained = result.abstained;
    if (abstained) {
      console.warn(`[abstain] ${rel} — raw-string parsing was inconclusive, file left untouched`);
    }
  } else {
    next = stripTsSource(source, { keepJsdoc: isPublishedJsdocFile(rel) });
  }
  if (next !== source) {
    await writeFile(file, next, "utf8");
  }
  return { before: source.length, after: next.length, abstained };
}

/**
 * Repo-relative path prefixes this run is allowed to rewrite, from `--paths a,b,c`.
 *
 * A bare invocation selects NOTHING. That default is the finding of the 2026-09 sweep, not
 * caution for its own sake: the protected-set guard below is a marker heuristic, and this
 * repo's comments are load-bearing well beyond the twelve markers it knows. The largest
 * single candidate for stripping, `agents/negotiate.ts`, would have lost 25KB explaining why
 * a `graph-only` subject is structurally zero for every lane except ownership - reasoning the
 * code cannot restate and no marker matches. So the guard is a floor, never a licence: a
 * human names the paths, having read them.
 */
function selectedPaths(argv: readonly string[]): string[] {
  const flag = argv.find((a) => a.startsWith("--paths="));
  if (flag === undefined) return [];
  return flag
    .slice("--paths=".length)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const paths = selectedPaths(process.argv);
  if (!dryRun && paths.length === 0) {
    console.error(
      [
        "strip-comments: refusing to rewrite the whole repo.",
        "  --dry-run                 report what WOULD change, touching nothing",
        "  --paths=<a,b>             rewrite only files under these repo-relative prefixes",
        "Comments here are load-bearing by default; name the paths you have read.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }
  // Fail-closed: if the attested-comment set cannot be built, strip nothing. An empty
  // protected set is indistinguishable from "this repo has no attested comments", and
  // acting on that reading is how 152 documented citations would be deleted silently.
  const citedFiles = await loadInvariantCitedFiles();
  let totalBefore = 0,
    totalAfter = 0,
    fileCount = 0,
    changed = 0,
    abstained = 0,
    refused = 0;
  const refusedByReason = new Map<string, number>();
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    fileCount++;
    const rel = relPath(file);
    if (paths.length > 0 && !paths.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    const verdict = protectionFor(rel, await readFile(file, "utf8"), citedFiles);
    if (verdict.protected) {
      refused++;
      refusedByReason.set(verdict.reason, (refusedByReason.get(verdict.reason) ?? 0) + 1);
      continue;
    }
    if (dryRun) {
      const source = await readFile(file, "utf8");
      let nextText: string;
      if (file.endsWith(".rs")) {
        const r = stripRustSource(source);
        if (r.abstained) {
          abstained++;
          console.warn(`[abstain] ${relPath(file)}`);
        }
        nextText = r.stripped;
      } else {
        nextText = stripTsSource(source, { keepJsdoc: isPublishedJsdocFile(relPath(file)) });
      }
      totalBefore += source.length;
      totalAfter += nextText.length;
      if (nextText !== source) changed++;
    } else {
      const result = await stripFile(file);
      totalBefore += result.before;
      totalAfter += result.after;
      if (result.before !== result.after) changed++;
      if (result.abstained) abstained++;
    }
  }
  console.log(
    `${dryRun ? "[dry-run] " : ""}Files: ${fileCount}, refused: ${refused}, changed: ${changed}, abstained: ${abstained}, bytes: ${totalBefore} -> ${totalAfter}`,
  );
  for (const [reason, n] of [...refusedByReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${String(n)} — ${reason}`);
  }
  if (abstained > 0) {
    console.warn(
      `[!] ${abstained} .rs files were left untouched due to raw-string ambiguity. Audit them manually.`,
    );
  }
}

if (import.meta.main) await main();
