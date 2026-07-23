#!/usr/bin/env bun

import { auditOutputPath, REPO_ROOT } from "./lib.ts";

type StepResult =
  | { name: string; ok: true; durationMs: number }
  | { name: string; ok: false; durationMs: number; exitCode: number };

async function step(name: string, cmd: readonly string[]): Promise<StepResult> {
  const start = performance.now();
  const proc = Bun.spawnSync([...cmd], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const durationMs = Math.round(performance.now() - start);
  const ok = proc.exitCode === 0;
  return ok
    ? { name, ok, durationMs }
    : { name, ok: false, durationMs, exitCode: proc.exitCode ?? 1 };
}

async function run(): Promise<void> {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");

  const steps: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "dependency-cruiser",
      [
        "bunx",
        "dependency-cruiser",
        "--config",
        ".dependency-cruiser.cjs",
        "--no-progress",
        "--output-type",
        "err",
        "packages",
      ],
    ],
    ["jscpd", ["bunx", "jscpd", "packages"]],
    ["knip", ["bunx", "knip", "--reporter", "json"]],
    ["file-loc", ["bun", "run", "scripts/structure-audit/measure-file-loc.ts"]],
    ["any-count", ["bun", "run", "scripts/structure-audit/count-any-usage.ts"]],
    ["risky-assertions", ["bun", "run", "scripts/structure-audit/list-risky-assertions.ts"]],
    ["nimbus-invariants", ["bun", "run", "scripts/structure-audit/check-nimbus-invariants.ts"]],
    ["git-churn", ["bun", "run", "scripts/structure-audit/get-git-churn.ts"]],
  ];
  const results: StepResult[] = [];
  for (const [name, cmd] of steps) {
    results.push(await step(name, cmd));
  }

  const outPath = auditOutputPath(`run-${timestamp}.json`);
  await Bun.write(outPath, `${JSON.stringify({ timestamp, results }, null, 2)}\n`);
  console.log(`\nOrchestrator run blob: ${outPath}`);
  for (const r of results) {
    console.log(`  ${r.ok ? "OK " : "FAIL"} ${r.durationMs.toString().padStart(6)}ms  ${r.name}`);
  }

  // Don't exit non-zero on individual tool failures — the orchestrator's job is to
  // collect signal, not gate. The CI gate (_structure.yml) calls binary tools directly.
}

if (import.meta.main) await run();
