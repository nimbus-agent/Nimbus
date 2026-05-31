#!/usr/bin/env bun

import { auditOutputPath, iterateSourceFiles, stripComments } from "./lib.ts";

export type Hit = { file: string; line: number; snippet: string };

const RE = /\bas\s+(?!const\b|unknown\b)([A-Za-z_]\w*)/g;

export function findRiskyAssertions(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  const stripped = stripComments(src);
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    RE.lastIndex = 0;
    let m = RE.exec(line);
    while (m !== null) {
      hits.push({ file, line: i + 1, snippet: line.trim() });
      m = RE.exec(line);
    }
  }
  return hits;
}

async function run(): Promise<void> {
  const all: Hit[] = [];
  for await (const f of iterateSourceFiles()) {
    all.push(...findRiskyAssertions(f.relPath, f.contents));
  }
  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  const outPath = auditOutputPath("risky-assertions.json");
  await Bun.write(outPath, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`risky assertions: ${all.length} → ${outPath}`);
}

if (import.meta.main) await run();
