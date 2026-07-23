// scripts/cleanup/survey-srp.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

async function main() {
  interface Row {
    file: string;
    loc: number;
    exports: number;
    names: string[];
  }
  const rows: Row[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    if (relPath(file).startsWith("scripts/cleanup/")) continue;
    if (file.endsWith(".rs")) continue;
    const source = await readFile(file, "utf8");
    const loc = source.split(/\r?\n/).length;
    if (loc <= 500) continue;
    const names: string[] = [];
    for (const m of source.matchAll(EXPORT_RE)) {
      const name = m[1];
      if (name !== undefined) names.push(name);
    }
    rows.push({ file: relPath(file), loc, exports: names.length, names });
  }
  rows.sort((a, b) => b.loc - a.loc);
  const out: string[] = ["# Punch list — section 3: SRP offenders (>500 LOC)", ""];
  out.push(
    `Total files: ${rows.length}`,
    "",
    "| File | LOC | Exports | Names (first 8) |",
    "|---|---|---|---|",
  );
  for (const r of rows) {
    out.push(
      `| \`${r.file}\` | ${r.loc} | ${r.exports} | ${r.names.slice(0, 8).join(", ")}${r.names.length > 8 ? "…" : ""} |`,
    );
  }
  out.push(
    "",
    "## Triage rule",
    "",
    "- LOC>500 + exports>=3 unrelated symbols → split candidate.",
    "- LOC>500 + one cohesive exported class/function → keep but audit for internal SRP.",
    "- LOC>500 in a test file → ignore for pass 5 (tests are frozen).",
  );
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/03-srp-offenders.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote ${rows.length} SRP candidates to ${relPath(target)}`);
}

await main();
