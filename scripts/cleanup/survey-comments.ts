// scripts/cleanup/survey-comments.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CommentHit, iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

const MARKERS = [
  { name: "I-numbered", pattern: /\bI[1-9]\d?\b/ },
  { name: "HITL", pattern: /\bHITL\b/ },
  { name: "WHY", pattern: /\bWHY:/ },
  { name: "NOTE", pattern: /\bNOTE:/ },
  { name: "WORKAROUND", pattern: /\bWORKAROUND\b/i },
  { name: "BUG-ref", pattern: /\bBUG-[A-Z0-9-]+\b/ },
  { name: "ticket-ref", pattern: /#\d{2,}/ },
  { name: "TODO", pattern: /\bTODO\b/ },
  { name: "FIXME", pattern: /\bFIXME\b/ },
  { name: "HACK", pattern: /\bHACK\b/ },
  { name: "XXX", pattern: /\bXXX\b/ },
  { name: "security/timing", pattern: /\b(constant-?time|side-?channel|leak)\b/i },
];

function findCommentLines(source: string): Array<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (inBlock) {
      hits.push({ line: i + 1, text: raw.trim() });
      if (raw.includes("*/")) inBlock = false;
      continue;
    }
    const slashIdx = raw.indexOf("//");
    const blockIdx = raw.indexOf("/*");
    if (blockIdx >= 0 && (slashIdx < 0 || blockIdx < slashIdx)) {
      hits.push({ line: i + 1, text: raw.slice(blockIdx).trim() });
      if (!raw.slice(blockIdx).includes("*/")) inBlock = true;
    } else if (slashIdx >= 0) {
      hits.push({ line: i + 1, text: raw.slice(slashIdx).trim() });
    }
  }
  return hits;
}

async function main() {
  const allHits: CommentHit[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    if (relPath(file).startsWith("scripts/cleanup/")) continue;
    const source = await readFile(file, "utf8");
    const lines = findCommentLines(source);
    for (const { line, text } of lines) {
      for (const { name, pattern } of MARKERS) {
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
