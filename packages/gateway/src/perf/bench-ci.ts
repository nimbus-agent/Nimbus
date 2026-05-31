#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhCli } from "./bench-ci-gh.ts";
import type { HistoryLine } from "./history-line.ts";
import { COMMENT_MARKER_PREFIX, formatPrComment } from "./pr-comment-formatter.ts";
import { SLO_THRESHOLDS, thresholdsBySurface } from "./slo-thresholds.ts";
import {
  compareAgainstHistory,
  isFailingComparison,
  type SurfaceComparison,
} from "./threshold-comparator.ts";
import type { RunnerKind } from "./types.ts";

export interface RunBenchCiDeps {
  gh: GhCli;
  env?: Record<string, string | undefined>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  tmpDir?: string;
}

interface ParsedArgs {
  current: string;
  runner: RunnerKind;
  prevDir?: string;
}

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function parseArgs(args: string[]): ParsedArgs {
  const current = takeFlag(args, "--current");
  const runner = takeFlag(args, "--runner");
  const prevDir = takeFlag(args, "--prev-dir");
  if (current === undefined) throw new Error("--current <path> is required");
  if (runner === undefined) throw new Error("--runner <runner-id> is required");
  return { current, runner: runner as RunnerKind, ...(prevDir !== undefined && { prevDir }) };
}

function parseHistoryFile(path: string): HistoryLine {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((s) => s.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error(`history file is empty: ${path}`);
  return JSON.parse(last) as HistoryLine;
}

function readPullRequestNumber(env: Record<string, string | undefined>): number | null {
  const ref = env["GITHUB_REF"];
  if (ref === undefined) return null;
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  return m === null ? null : Number.parseInt(m[1] ?? "", 10);
}

async function resolvePreviousArtifact(
  gh: GhCli,
  runner: RunnerKind,
  prevDir: string,
  stderr: (s: string) => void,
): Promise<HistoryLine | null> {
  let runId: number | null = null;
  try {
    runId = await gh.runListLatestSuccess({ workflow: "_perf.yml", branch: "main" });
  } catch (err) {
    stderr(
      `bench-ci: gh run list failed: ${err instanceof Error ? err.message : String(err)}; treating as first-run`,
    );
    return null;
  }
  if (runId === null) return null;

  let prevSha: string | null = null;
  try {
    prevSha = await gh.runViewHeadSha({ runId });
  } catch (err) {
    stderr(
      `bench-ci: gh run view failed: ${err instanceof Error ? err.message : String(err)}; treating as first-run`,
    );
    return null;
  }
  if (prevSha === null) return null;

  mkdirSync(prevDir, { recursive: true });
  const artifactName = `perf-${runner}-${prevSha}`;
  let downloaded = false;
  try {
    downloaded = await gh.runDownloadArtifact({ runId, name: artifactName, dir: prevDir });
  } catch (err) {
    stderr(
      `bench-ci: gh run download failed: ${err instanceof Error ? err.message : String(err)}; treating as first-run`,
    );
    return null;
  }
  if (!downloaded) return null;

  try {
    return parseHistoryFile(join(prevDir, "run-history.jsonl"));
  } catch (err) {
    stderr(
      `bench-ci: previous artifact unreadable: ${err instanceof Error ? err.message : String(err)}; treating as first-run`,
    );
    return null;
  }
}

async function upsertComment(
  gh: GhCli,
  pr: number,
  runner: RunnerKind,
  body: string,
  tmpDir: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const scratchDir = mkdtempSync(join(tmpDir, `bench-ci-comment-${runner}-`));
  const bodyFile = join(scratchDir, "body.md");
  writeFileSync(bodyFile, body, "utf8");

  const marker = `<!-- ${COMMENT_MARKER_PREFIX}:${runner} -->`;
  const existing = await gh.prCommentList({ pr });
  const ours = existing.find((c) => c.body.startsWith(marker));
  const repo = env["GITHUB_REPOSITORY"];
  if (ours !== undefined && repo !== undefined) {
    await gh.prCommentEdit({ commentId: ours.id, bodyFile, repo });
  } else {
    await gh.prCommentCreate({ pr, bodyFile });
  }
}

function writeStepSummary(env: Record<string, string | undefined>, body: string): void {
  const path = env["GITHUB_STEP_SUMMARY"];
  if (path === undefined) return;
  writeFileSync(path, `${body}\n`, { flag: "a" });
}

function decideExit(comparisons: readonly SurfaceComparison[]): number {
  const lookup = thresholdsBySurface();
  for (const c of comparisons) {
    const slo = lookup.get(c.surfaceId);
    if (slo === undefined) continue;
    if (isFailingComparison(c, slo)) return 1;
  }
  return 0;
}

export async function runBenchCiMain(args: string[], deps: RunBenchCiDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const tmpRoot = deps.tmpDir ?? tmpdir();

  const { current: currentPath, runner, prevDir } = parseArgs(args);
  const current = parseHistoryFile(currentPath);

  const previous = await resolvePreviousArtifact(
    deps.gh,
    runner,
    prevDir ?? join(tmpRoot, `bench-ci-prev-${runner}`),
    stderr,
  );

  const comparisons = compareAgainstHistory(current, previous, SLO_THRESHOLDS, runner);
  const body = formatPrComment(comparisons, current, previous);
  stdout(body);
  writeStepSummary(env, body);

  if (env["GITHUB_EVENT_NAME"] === "pull_request") {
    const pr = readPullRequestNumber(env);
    if (pr !== null) {
      try {
        await upsertComment(deps.gh, pr, runner, body, tmpRoot, env);
      } catch (err) {
        stderr(
          `bench-ci: comment upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return decideExit(comparisons);
}

if (import.meta.main) {
  const code = await runBenchCiMain(process.argv.slice(2), { gh: new GhCli() });
  process.exit(code);
}
