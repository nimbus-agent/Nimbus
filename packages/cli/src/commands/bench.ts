import { resolve } from "node:path";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const HELP = `nimbus bench — perf bench harness (Phase 1A)

Usage:
  nimbus bench --surface <id> [--corpus small|medium|large] [--runs N] (--reference|--gha)
  nimbus bench --all [--corpus ...] [--runs N] (--reference|--gha)

Flags:
  --surface <id>      one of: S1, S2-a, S2-b, S2-c, S3, S4, S5, S11-a, S11-b
                      (cluster C — S6/S7/S8/S9/S10 — lands in PR-B-2b)
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

function resolveBenchRunnerPath(): string {
  return resolve(import.meta.dir, "..", "..", "..", "gateway", "src", "perf", "bench-runner.ts");
}

export interface RunBenchDeps {
  spawn?: typeof Bun.spawn;
  stdout?: (s: string) => void;
}

export async function runBench(args: string[], deps: RunBenchDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    stdout(HELP);
    return 0;
  }

  const spawn = deps.spawn ?? Bun.spawn;
  const runner = resolveBenchRunnerPath();

  const proc = spawn([process.execPath, runner, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  return typeof exitCode === "number" ? exitCode : 1;
}
