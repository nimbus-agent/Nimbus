#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { medianOf } from "../../packages/gateway/src/perf/baseline-median.ts";
import { GhCli } from "../../packages/gateway/src/perf/bench-ci-gh.ts";
import type {
  HistoryLine,
  HistoryLineSurface,
} from "../../packages/gateway/src/perf/history-line.ts";
import type { SloThreshold } from "../../packages/gateway/src/perf/slo-thresholds.ts";
import { SLO_THRESHOLDS } from "../../packages/gateway/src/perf/slo-thresholds.ts";
import { isFloorMetric } from "../../packages/gateway/src/perf/threshold-comparator.ts";
import type { BenchSurfaceId, RunnerKind } from "../../packages/gateway/src/perf/types.ts";

// ─── Pure core ───────────────────────────────────────────────────────────────

/** One historical metric sample for a single surface, oldest-first. */
export interface DriftSample {
  value: number;
}

/**
 * Pure drift detector. Walks a rolling median of the last `k` samples and reports
 * drift only when the `n` most recent samples are EACH worse than that window's
 * median by more than `noiseFloorPct` percent. A lone spike never trips; a
 * sustained regression does. "Worse" == "larger" (smaller-is-better surfaces only).
 */
export function detectDrift(
  history: readonly DriftSample[],
  noiseFloorPct: number,
  k = 7,
  n = 3,
): boolean {
  if (history.length < k + n) return false;
  let consecutive = 0;
  for (let i = k; i < history.length; i += 1) {
    const window = history.slice(i - k, i).map((s) => s.value);
    const med = window.length === 0 ? 0 : medianOf(window);
    const current = history[i]?.value;
    if (current === undefined || med <= 0) {
      consecutive = 0;
      continue;
    }
    const worsePct = ((current - med) / med) * 100;
    if (worsePct > noiseFloorPct) {
      consecutive += 1;
      if (consecutive >= n) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

// ─── I/O wrapper ─────────────────────────────────────────────────────────────

const DRIFT_NOISE_FLOOR_PCT = 10;
const DRIFT_HISTORY_RUNS = 14;
const DRIFT_ISSUE_LABEL = "perf-drift";
const PERF_WORKFLOW = "_perf.yml";

type TrendMetric = Exclude<SloThreshold["metric"], "throughput_per_sec" | "tokens_per_sec">;

function historyFieldFor(metric: TrendMetric): keyof HistoryLineSurface {
  switch (metric) {
    case "p95_ms":
      return "p95_ms";
    case "p50_ms":
      return "p50_ms";
    case "rss_bytes_p95":
      return "rss_bytes_p95";
    case "first_token_ms":
      return "first_token_ms";
  }
}

/** Map from surfaceId → history field key, only for trend surfaces that are smaller-is-better. */
const TREND_METRIC_BY_SURFACE: ReadonlyMap<BenchSurfaceId, keyof HistoryLineSurface> = new Map(
  SLO_THRESHOLDS.filter(
    (s): s is SloThreshold & { metric: TrendMetric } =>
      s.gateClass === "trend" && !isFloorMetric(s.metric),
  ).map((s) => [s.surfaceId, historyFieldFor(s.metric)]),
);

interface GhIssue {
  number: number;
  title: string;
}

async function ghSpawn(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function ghIssueList(label: string): Promise<GhIssue[]> {
  const r = await ghSpawn([
    "issue",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,title",
  ]);
  if (r.exitCode !== 0) return [];
  const text = r.stdout.trim();
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: GhIssue[] = [];
  for (const x of parsed) {
    if (
      typeof x === "object" &&
      x !== null &&
      typeof (x as Record<string, unknown>)["number"] === "number" &&
      typeof (x as Record<string, unknown>)["title"] === "string"
    ) {
      result.push({
        number: (x as Record<string, unknown>)["number"] as number,
        title: (x as Record<string, unknown>)["title"] as string,
      });
    }
  }
  return result;
}

async function upsertDriftIssue(
  surfaceId: BenchSurfaceId,
  runner: RunnerKind,
  existingIssues: GhIssue[],
  stderr: (s: string) => void,
): Promise<void> {
  const issueTitle = `perf: sustained drift detected on ${surfaceId} (${runner})`;
  const existing = existingIssues.find((i) => i.title === issueTitle);

  if (existing !== undefined) {
    const r = await ghSpawn([
      "issue",
      "comment",
      String(existing.number),
      "--body",
      `Drift re-detected on \`${surfaceId}\` for runner \`${runner}\`. The rolling-median detector has flagged a sustained regression again.`,
    ]);
    if (r.exitCode !== 0) {
      stderr(`drift-check: gh issue comment failed for #${String(existing.number)}: ${r.stderr}`);
    }
  } else {
    const r = await ghSpawn([
      "issue",
      "create",
      "--title",
      issueTitle,
      "--label",
      DRIFT_ISSUE_LABEL,
      "--body",
      `The rolling-median drift detector has flagged surface \`${surfaceId}\` on runner \`${runner}\`.\n\nThe last 3+ consecutive samples are each more than ${String(DRIFT_NOISE_FLOOR_PCT)}% worse than the rolling median of the preceding 7 samples. This indicates a sustained regression rather than a one-off spike.\n\nPlease investigate recent commits for performance regressions on this surface.`,
    ]);
    if (r.exitCode !== 0) {
      stderr(`drift-check: gh issue create failed for ${surfaceId}: ${r.stderr}`);
    }
  }
}

/**
 * A v2 HistoryLine carries a `surfaces` map and `schema_version: 2`. v1 history
 * (median-of-per-run-p95 aggregation) is non-comparable, so it is skipped rather
 * than silently mixed into the drift series where it would skew the rolling median.
 */
function isHistoryLineV2(parsed: unknown): parsed is HistoryLine {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { schema_version?: unknown }).schema_version === 2 &&
    typeof (parsed as { surfaces?: unknown }).surfaces === "object" &&
    (parsed as { surfaces?: unknown }).surfaces !== null
  );
}

export function parseHistoryLines(path: string): HistoryLine[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: HistoryLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isHistoryLineV2(parsed)) lines.push(parsed);
      // skip schema_version 1 (non-comparable) or otherwise malformed lines
    } catch {
      // skip malformed lines
    }
  }
  return lines;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunDriftCheckDeps {
  gh: GhCli;
  runner: RunnerKind;
  tmpDir?: string;
  stderr?: (s: string) => void;
}

export async function runDriftCheckMain(deps: RunDriftCheckDeps): Promise<void> {
  const runner = deps.runner;
  const tmpRoot = deps.tmpDir ?? tmpdir();
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));

  // Fetch recent successful main runs
  let runs: { databaseId: number; headSha: string }[];
  try {
    runs = await deps.gh.runListRecentSuccesses({
      workflow: PERF_WORKFLOW,
      branch: "main",
      limit: DRIFT_HISTORY_RUNS,
    });
  } catch (err) {
    stderr(`drift-check: gh run list failed: ${errMsg(err)}; aborting`);
    return;
  }

  if (runs.length === 0) {
    stderr("drift-check: no successful main runs found; nothing to check");
    return;
  }

  // `gh run list` returns runs newest-first; detectDrift walks the series as a
  // time axis (index 0 = oldest), so reverse to oldest-first before collecting.
  runs.reverse();

  // Download artifacts and collect HistoryLines, oldest-first
  const scratchDir = mkdtempSync(join(tmpRoot, "drift-check-"));
  const historyLines: HistoryLine[] = [];
  for (const { databaseId, headSha } of runs) {
    const artifactName = `perf-${runner}-${headSha}`;
    const dir = join(scratchDir, headSha);
    mkdirSync(dir, { recursive: true });
    let downloaded = false;
    try {
      downloaded = await deps.gh.runDownloadArtifact({
        runId: databaseId,
        name: artifactName,
        dir,
      });
    } catch (err) {
      stderr(`drift-check: download (${headSha}) failed: ${errMsg(err)}; skipping`);
      continue;
    }
    if (!downloaded) continue;
    const lines = parseHistoryLines(join(dir, "run-history.jsonl"));
    historyLines.push(...lines);
  }

  if (historyLines.length === 0) {
    stderr("drift-check: no history lines collected; nothing to check");
    return;
  }

  // Load existing open drift issues once (to avoid N issue-list calls)
  const existingIssues = await ghIssueList(DRIFT_ISSUE_LABEL);

  // Check each trend (smaller-is-better) surface for drift
  for (const [surfaceId, field] of TREND_METRIC_BY_SURFACE) {
    const series: DriftSample[] = historyLines
      .map((line) => {
        const surface: HistoryLineSurface | undefined = line.surfaces[surfaceId];
        if (surface === undefined) return null;
        const val = surface[field];
        if (typeof val !== "number") return null;
        return { value: val };
      })
      .filter((s): s is DriftSample => s !== null);

    if (!detectDrift(series, DRIFT_NOISE_FLOOR_PCT)) continue;

    stderr(`drift-check: drift detected on ${surfaceId} (${runner}); upserting gh issue`);
    try {
      await upsertDriftIssue(surfaceId, runner, existingIssues, stderr);
    } catch (err) {
      stderr(`drift-check: upsert failed for ${surfaceId}: ${errMsg(err)}`);
    }
  }
}

/** The full `RunnerKind` set, used to validate the `NIMBUS_PERF_RUNNER` env var at startup. */
const RUNNER_KINDS: ReadonlySet<RunnerKind> = new Set<RunnerKind>([
  "reference-m1air",
  "gha-ubuntu",
  "gha-macos",
  "gha-windows",
  "local-dev",
]);

export function isRunnerKind(value: string): value is RunnerKind {
  return (RUNNER_KINDS as ReadonlySet<string>).has(value);
}

if (import.meta.main) {
  const runnerEnv = process.env["NIMBUS_PERF_RUNNER"] ?? "gha-ubuntu";
  if (!isRunnerKind(runnerEnv)) {
    process.stderr.write(
      `drift-check: invalid NIMBUS_PERF_RUNNER "${runnerEnv}"; expected one of ${[...RUNNER_KINDS].join(", ")}\n`,
    );
    process.exit(1);
  }
  await runDriftCheckMain({
    gh: new GhCli(),
    runner: runnerEnv,
  });
}
