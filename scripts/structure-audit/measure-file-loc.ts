#!/usr/bin/env bun

import { auditOutputPath, iterateSourceFiles } from "./lib.ts";

export function rawLoc(src: string): number {
  if (src.length === 0) return 0;
  const newlines = (src.match(/\n/g) ?? []).length;
  return src.endsWith("\n") ? newlines : newlines + 1;
}

export type FileLoc = { file: string; loc: number };

async function run(): Promise<void> {
  const all: FileLoc[] = [];
  for await (const f of iterateSourceFiles()) {
    all.push({ file: f.relPath, loc: rawLoc(f.contents) });
  }
  all.sort((a, b) => b.loc - a.loc);
  const outPath = auditOutputPath("file-loc.json");
  await Bun.write(outPath, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`file LOC report: ${all.length} files → ${outPath}`);
  console.log(`Top 10:`);
  for (const e of all.slice(0, 10)) console.log(`  ${e.loc}\t${e.file}`);
}

if (import.meta.main) await run();
