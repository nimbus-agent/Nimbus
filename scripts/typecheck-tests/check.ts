// scripts/typecheck-tests/check.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate, parseBaseline, serializeBaseline } from "./baseline.ts";
import { type ErrorCounts, parseTscOutput } from "./parse.ts";
import { type ProjectRun, ranSuccessfully, unrunnableReport } from "./toolchain.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BASELINE = resolve(REPO_ROOT, "docs", "structure-audit", "typecheck-tests-baseline.json");
const PROJECTS = [
  "packages/gateway/tsconfig.tests.json",
  "packages/ui/tsconfig.tests.json",
] as const;

interface Collected {
  readonly counts: ErrorCounts;
  readonly runs: readonly ProjectRun[];
}

function collect(): Collected {
  const merged: ErrorCounts = new Map();
  const runs: ProjectRun[] = [];
  for (const project of PROJECTS) {
    // `--pretty false` pins the diagnostic format the parser's regex depends on. tsc picks pretty
    // (colour + box-drawing) output whenever it thinks it has a TTY, and that layout carries no
    // `file(line,col): error TSxxxx:` line at all — the regex would match nothing and the gate
    // would read a fully broken project as clean.
    const p = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--pretty", "false", "-p", project], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = `${p.stdout.toString()}\n${p.stderr.toString()}`;
    // Pass REPO_ROOT so an absolute path from tsc is reduced to a repo-relative key.
    const parsed = parseTscOutput(raw, REPO_ROOT);
    let errorCount = 0;
    for (const [file, byCode] of parsed) {
      const target = merged.get(file) ?? new Map<string, number>();
      for (const [code, n] of byCode) {
        target.set(code, (target.get(code) ?? 0) + n);
        errorCount += n;
      }
      merged.set(file, target);
    }
    runs.push({ project, exitCode: p.exitCode ?? -1, errorCount, output: raw });
  }
  return { counts: merged, runs };
}

/**
 * Fail loudly the moment any project's exit code and diagnostic count disagree. Applied to BOTH
 * arms: refusing to write a baseline from an unrunnable toolchain is the point — the previous code
 * happily wrote an EMPTY baseline and printed `baseline updated (0 errors across 0 files)`.
 */
function assertAllProjectsRan(runs: readonly ProjectRun[]): void {
  const broken = runs.filter((r) => !ranSuccessfully(r));
  if (broken.length === 0) return;
  for (const run of broken) console.error(unrunnableReport(run));
  console.error(
    `typecheck-tests: ${String(broken.length)} project(s) did not typecheck — refusing to report a result`,
  );
  process.exit(2);
}

function totalErrors(counts: ErrorCounts): number {
  return [...counts.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
}

async function main(): Promise<void> {
  const update = process.argv.slice(2).includes("--update-baseline");
  const { counts: actual, runs } = collect();
  assertAllProjectsRan(runs);

  if (update) {
    await Bun.write(BASELINE, serializeBaseline(actual, new Date().toISOString()));
    console.log(
      `typecheck-tests: baseline updated (${String(totalErrors(actual))} errors across ${String(actual.size)} files)`,
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

  console.log(
    `typecheck-tests: ok (${String(totalErrors(baseline))} known errors baselined, 0 new)`,
  );
}

await main();
