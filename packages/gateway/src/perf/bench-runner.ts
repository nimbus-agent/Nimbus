#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { runBenchCli } from "./bench-cli.ts";
import { type IncompleteContext, installIncompleteSignalHandler } from "./signal-handler.ts";
import type { RunnerKind } from "./types.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const HELP = `nimbus bench — perf bench harness (Phase 1A)

Usage:
  nimbus bench --surface <id> [--corpus small|medium|large] [--runs N] (--reference|--gha)
  nimbus bench --all [--corpus ...] [--runs N] (--reference|--gha)

Flags:
  --surface <id>      one of: S1, S2-a, S2-b, S2-c, S3, S4, S5, S6-drive, S6-gmail, S6-github,
                      S7-a, S7-b, S7-c, S8-l{50|500|5000}-b{1|8|32|64} (12 cells),
                      S9, S10, S11-a, S11-b
  --all               run every registered surface
  --corpus <tier>     small | medium | large
  --runs <N>          per-surface invocations (default 5)
  --reference         tag as reference-m1air (interactive protocol confirm by default)
  --protocol-confirmed  non-interactive §4.2 protocol confirmation; intended for CI
                        dispatch from .github/workflows/_perf-reference.yml
  --gha               tag as gha-<os> (auto-derived from process.platform)
  --history <path>    history.jsonl override
  --fixture-cache <p> fixture cache dir override
  --help              this message

See the B2 perf audit design for the surface table.
`;

function detectRunner(args: string[]): RunnerKind {
  if (hasFlag(args, "--reference")) return "reference-m1air";
  if (hasFlag(args, "--gha")) {
    if (process.platform === "darwin") return "gha-macos";
    if (process.platform === "win32") return "gha-windows";
    return "gha-ubuntu";
  }
  return "local-dev";
}

export interface BenchRunnerDeps {
  stdout?: (s: string) => void;
  historyPath?: string;
}

export async function runBenchRunnerMain(
  args: string[],
  deps: BenchRunnerDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(`${s}\n`));
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    stdout(HELP);
    return 0;
  }

  const protocolConfirmed = hasFlag(args, "--protocol-confirmed");
  const cliArgs = protocolConfirmed ? args.filter((a) => a !== "--protocol-confirmed") : args;

  const historyPath =
    deps.historyPath ??
    takeFlag(cliArgs, "--history") ??
    join(process.cwd(), "docs/perf/history.jsonl");
  const fixtureCacheDir = takeFlag(cliArgs, "--fixture-cache");

  const runId = randomUUID();
  const runner = detectRunner(cliArgs);

  const ctxFactory = (): IncompleteContext => ({
    runId,
    runner,
    reason: "interrupted",
    nimbusGitSha: process.env["GITHUB_SHA"] ?? "unknown",
    bunVersion: typeof Bun === "undefined" ? "unknown" : Bun.version,
    osVersion: `${process.platform} ${process.arch}`,
  });
  const uninstall = installIncompleteSignalHandler(historyPath, ctxFactory);

  try {
    return await runBenchCli(cliArgs, {
      runId,
      historyPath,
      ...(fixtureCacheDir !== undefined && { fixtureCacheDir }),
      ...(protocolConfirmed && { confirmReferenceProtocol: () => true }),
      stdout,
      stderr: (s) => process.stderr.write(`${s}\n`),
    });
  } finally {
    uninstall();
  }
}

if (import.meta.main) {
  process.exitCode = await runBenchRunnerMain(process.argv.slice(2));
}
