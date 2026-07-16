import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

const PRESERVE_PRAGMAS = [
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "biome-ignore",
  "eslint-disable",
  "dprint-ignore",
  "prettier-ignore",
  "cross-platform-ok",
  "audit-ignore-next-line",
  "<reference ",
];

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
      if (shouldPreserveComment(text)) continue;
      if (opts.keepJsdoc && isJsdoc(text)) continue;
      const start = r.pos;
      let end = r.end;
      if (r.hasTrailingNewLine) end = Math.min(source.length, end + 1);
      removals.push({ start, end });
      emittedStarts.add(r.pos);
    }
  }

  function walk(node: ts.Node): void {
    scanCommentsAtPosition(node.getFullStart(), true);
    scanCommentsAtPosition(node.getEnd(), false);
    node.forEachChild(walk);
  }
  walk(sf);

  removals.sort((a, b) => b.start - a.start);
  let out = source;
  for (const { start, end } of removals) {
    out = out.slice(0, start) + out.slice(end);
  }
  if (source.startsWith("#!") && !out.startsWith("#!")) {
    const nl = source.indexOf("\n");
    if (nl > 0) out = source.slice(0, nl + 1) + out;
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

export function stripRustSource(source: string): { stripped: string; abstained: boolean } {
  const out: string[] = [];
  let i = 0;
  let abstained = false;
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];

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
        out.push(source.slice(i, end + terminator.length));
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
      out.push(source.slice(start, i));
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
      out.push(source.slice(start, i));
      continue;
    }

    if (c === "/" && c2 === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && c2 === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) {
        abstained = true;
        break;
      }
      i = end + 2;
      continue;
    }

    out.push(c);
    i++;
  }
  if (abstained) return { stripped: source, abstained: true };
  return { stripped: out.join("").replace(/\n{3,}/g, "\n\n"), abstained: false };
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let totalBefore = 0,
    totalAfter = 0,
    fileCount = 0,
    changed = 0,
    abstained = 0;
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    fileCount++;
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
    `${dryRun ? "[dry-run] " : ""}Files: ${fileCount}, changed: ${changed}, abstained: ${abstained}, bytes: ${totalBefore} -> ${totalAfter}`,
  );
  if (abstained > 0) {
    console.warn(
      `[!] ${abstained} .rs files were left untouched due to raw-string ambiguity. Audit them manually.`,
    );
  }
}

if (import.meta.main) await main();
