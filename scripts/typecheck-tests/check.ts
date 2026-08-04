// scripts/typecheck-tests/check.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate, parseBaseline, serializeBaseline } from "./baseline.ts";
import { type ErrorCounts, parseTscOutput } from "./parse.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BASELINE = resolve(REPO_ROOT, "docs", "structure-audit", "typecheck-tests-baseline.json");
const PROJECTS = [
  "packages/gateway/tsconfig.tests.json",
  "packages/ui/tsconfig.tests.json",
] as const;

async function collect(): Promise<ErrorCounts> {
  const merged: ErrorCounts = new Map();
  for (const project of PROJECTS) {
    const p = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", project], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = `${p.stdout.toString()}\n${p.stderr.toString()}`;
    // Pass REPO_ROOT so an absolute path from tsc is reduced to a repo-relative key.
    for (const [file, byCode] of parseTscOutput(raw, REPO_ROOT)) {
      const target = merged.get(file) ?? new Map<string, number>();
      for (const [code, n] of byCode) target.set(code, (target.get(code) ?? 0) + n);
      merged.set(file, target);
    }
  }
  return merged;
}

async function main(): Promise<void> {
  const update = process.argv.slice(2).includes("--update-baseline");
  const actual = await collect();

  if (update) {
    await Bun.write(BASELINE, serializeBaseline(actual, new Date().toISOString()));
    const files = actual.size;
    const errors = [...actual.values()].reduce(
      (a, m) => a + [...m.values()].reduce((x, y) => x + y, 0),
      0,
    );
    console.log(
      `typecheck-tests: baseline updated (${String(errors)} errors across ${String(files)} files)`,
    );
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error(
      "typecheck-tests: baseline missing — run `bun run typecheck:tests:update-baseline`",
    );
    process.exit(2);
  }
  const baseline = parseBaseline(await Bun.file(BASELINE).text());
  const violations = evaluate(actual, baseline);

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        v.kind === "new_file"
          ? `::error file=${v.file}::typecheck-tests: NEW file with errors — ${v.code} ×${String(v.actual)}`
          : `::error file=${v.file}::typecheck-tests: ${v.code} regressed ${String(v.baseline)} -> ${String(v.actual)}`,
      );
    }
    console.error(`typecheck-tests: ${String(violations.length)} violation(s)`);
    process.exit(1);
  }

  const known = [...baseline.values()].reduce(
    (a, m) => a + [...m.values()].reduce((x, y) => x + y, 0),
    0,
  );
  console.log(`typecheck-tests: ok (${String(known)} known errors baselined, 0 new)`);
}

await main();
