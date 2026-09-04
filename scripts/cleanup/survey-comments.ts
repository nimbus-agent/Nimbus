// scripts/cleanup/survey-comments.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CommentHit, iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";
// One definition of "load-bearing", shared with strip-comments.ts so the surveyor and the
// guard that refuses to strip these files cannot drift apart.
import { findCommentLines, LOAD_BEARING_MARKERS } from "./protected-comments.ts";

async function main() {
  const allHits: CommentHit[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    if (relPath(file).startsWith("scripts/cleanup/")) continue;
    const source = await readFile(file, "utf8");
    const lines = findCommentLines(source);
    for (const { line, text } of lines) {
      for (const { name, pattern } of LOAD_BEARING_MARKERS) {
        if (pattern.test(text)) {
          allHits.push({ file: relPath(file), line, text, marker: name });
          break;
        }
      }
    }
  }
  const byMarker = new Map<string, CommentHit[]>();
  for (const hit of allHits) {
    const list = byMarker.get(hit.marker) ?? [];
    list.push(hit);
    byMarker.set(hit.marker, list);
  }
  const out: string[] = ["# Punch list — section 1: Load-bearing comments", ""];
  out.push(`Total hits: ${allHits.length}`, "");
  for (const [marker, hits] of [...byMarker.entries()].sort(([a], [b]) => (a > b ? 1 : -1))) {
    out.push(`## ${marker} (${hits.length})`, "");
    for (const h of hits) {
      const cleaned = h.text
        .replaceAll("`", "'")
        .replaceAll("|", String.raw`\|`)
        .trim()
        .slice(0, 200);
      out.push(`- \`${h.file}:${h.line}\` — \`${cleaned}\``);
    }
    out.push("");
  }
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/01-load-bearing-comments.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote ${allHits.length} hits to ${relPath(target)}`);
}

await main();
