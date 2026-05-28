#!/usr/bin/env bun

import { auditOutputPath, iterateSourceFiles, REPO_ROOT } from "./lib.ts";

export function computePercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const ascending = [...sorted].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * ascending.length);
  const idx = Math.min(Math.max(rank - 1, 0), ascending.length - 1);
  return ascending[idx] ?? 0;
}

function buildChurnMap(): Map<string, number> {
  const proc = Bun.spawnSync(
    ["git", "log", "--since=90 days ago", "--name-only", "--pretty=format:"],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return new Map();
  const text = new TextDecoder().decode(proc.stdout);
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const file = raw.trim();
    if (!file) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

async function run(): Promise<void> {
  const churn = buildChurnMap();
  const files: Array<{ file: string; commits90d: number }> = [];
  for await (const f of iterateSourceFiles()) {
    files.push({ file: f.relPath, commits90d: churn.get(f.relPath) ?? 0 });
  }
  files.sort((a, b) => b.commits90d - a.commits90d);
  const counts = files.map((e) => e.commits90d);
  const p80Threshold = computePercentile(counts, 80);
  const outPath = auditOutputPath("churn-90d.json");
  await Bun.write(outPath, `${JSON.stringify({ files, p80Threshold }, null, 2)}\n`);
  console.log(`churn report: ${files.length} files; p80 = ${p80Threshold}; → ${outPath}`);
  console.log(`Top 10 most-changed:`);
  for (const e of files.slice(0, 10)) console.log(`  ${e.commits90d}\t${e.file}`);
}

if (import.meta.main) await run();
