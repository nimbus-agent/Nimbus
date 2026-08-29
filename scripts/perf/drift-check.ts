#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  effectiveNoiseFloorPct,
  isFloorMetric,
} from "../../packages/gateway/src/perf/threshold-comparator.ts";
import type { BenchSurfaceId, RunnerKind } from "../../packages/gateway/src/perf/types.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

// ─── Pure core ───────────────────────────────────────────────────────────────

/** One historical metric sample for a single surface, oldest-first. */
export interface DriftSample {
  value: number;
}

/**
 * Pure drift detector. Walks a rolling median of the last `k` samples and reports
 * drift only when the `n` most recent samples are EACH worse than that window's
 * median by more than the surface's OWN noise floor. A lone spike never trips; a
 * sustained regression does. "Worse" == "larger" (smaller-is-better surfaces only).
 *
 * The floor is per-surface (`effectiveNoiseFloorPct`), not a global constant. It used to be a
 * hardcoded 10 %, and that is what filed #1308 and #1309: S11-a/S11-b declare a 40 % floor
 * precisely because their spawn-dominated latency is "a runner property, not a code signal"
 * (see their entries in `slo-thresholds.ts`), so a detector four times more sensitive than the
 * surface's own floor was guaranteed to alarm on runner noise.
 *
 * The failure is subtler than "too twitchy", and worth understanding before widening the floor
 * again. A rolling MEDIAN moves with the data, so a cluster of unusually FAST runs drags it
 * down — and the next ordinary samples then read as a regression against a depressed baseline.
 * That is exactly what happened: the tripping window was `224, 249, 261, 253, 247, 333, 306`
 * (median 253) against a series median of 311, so the "regression" was the runner RETURNING TO
 * NORMAL at 316 and 333. Nothing got slower. Across all 495 recorded samples, this rule fires
 * at 10 % and not once at 25 % or at the declared 40 %.
 */
export function detectDrift(
  history: readonly DriftSample[],
  slo: SloThreshold,
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
    if (worsePct > effectiveNoiseFloorPct(slo, med)) {
      consecutive += 1;
      if (consecutive >= n) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

// ─── I/O wrapper ─────────────────────────────────────────────────────────────

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

/**
 * Map from surfaceId → its history field key AND its SLO, for trend surfaces that are
 * smaller-is-better. The SLO travels with the field because the drift floor is per-surface;
 * carrying only the field is what forced the caller onto a global constant.
 */
const TREND_METRIC_BY_SURFACE: ReadonlyMap<
  BenchSurfaceId,
  { field: keyof HistoryLineSurface; slo: SloThreshold }
> = new Map(
  SLO_THRESHOLDS.filter(
    (s): s is SloThreshold & { metric: TrendMetric } =>
      s.gateClass === "trend" && !isFloorMetric(s.metric),
  ).map((s) => [s.surfaceId, { field: historyFieldFor(s.metric), slo: s }]),
);

interface GhIssue {
  number: number;
  title: string;
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

/**
 * Read the LAST line of a per-run `run-history.jsonl` artifact and return it only
 * if it is a comparable v2 HistoryLine. Each perf run writes a fresh single-run
 * file, so the last line is that run's result — one sample per run. A missing /
 * unreadable / malformed / non-v2 artifact yields null (skipped by the caller).
 */
export function parseLatestV2Line(path: string): HistoryLine | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let line: HistoryLine;
  try {
    line = parseLastHistoryLine(raw);
  } catch {
    return null;
  }
  return isHistoryLineV2(line) ? line : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function upsertDriftIssue(
  gh: GhCli,
  surfaceId: BenchSurfaceId,
  runner: RunnerKind,
  slo: SloThreshold,
  existingIssues: GhIssue[],
  tmpRoot: string,
  stderr: (s: string) => void,
): Promise<void> {
  const issueTitle = `perf: sustained drift detected on ${surfaceId} (${runner})`;
  if (existingIssues.some((i) => i.title === issueTitle)) {
    // Create-only: a standing open issue already represents this drift. Posting a
    // fresh comment every daily run would just be noise, so leave it untouched.
    stderr(`drift-check: open issue already tracks ${surfaceId} (${runner}); leaving it`);
    return;
  }
  const bodyDir = mkdtempSync(join(tmpRoot, "drift-issue-"));
  const bodyFile = join(bodyDir, "body.md");
  writeFileSync(
    bodyFile,
    `The rolling-median drift detector has flagged surface \`${surfaceId}\` on runner \`${runner}\`.\n\n` +
      `The last 3+ consecutive \`main\` samples are each more than ${String(slo.noiseFloorPct)}% worse than the rolling median of the preceding 7 -- this surface's OWN declared noise floor, not a global constant. This is a sustained regression, not a one-off spike.\n\n` +
      `See the [/dev/bench dashboard](https://github.com/nimbus-agent/Nimbus/tree/perf-data/dev/bench) and investigate recent commits for a regression on this surface.\n`,
    "utf8",
  );
  await gh.issueCreate({ title: issueTitle, label: DRIFT_ISSUE_LABEL, bodyFile });
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

  // `gh run list` is newest-first; detectDrift walks the series as a time axis
  // (index 0 = oldest), so reverse to oldest-first before collecting.
  runs.reverse();

  const scratchDir = mkdtempSync(join(tmpRoot, "drift-check-"));
  const historyLines: HistoryLine[] = [];
  for (const { databaseId, headSha } of runs) {
    const dir = join(scratchDir, headSha);
    mkdirSync(dir, { recursive: true });
    let downloaded = false;
    try {
      downloaded = await deps.gh.runDownloadArtifact({
        runId: databaseId,
        name: `perf-${runner}-${headSha}`,
        dir,
      });
    } catch (err) {
      stderr(`drift-check: download (${headSha}) failed: ${errMsg(err)}; skipping`);
      continue;
    }
    if (!downloaded) continue;
    const line = parseLatestV2Line(join(dir, "run-history.jsonl"));
    if (line !== null) historyLines.push(line);
  }
  if (historyLines.length === 0) {
    stderr("drift-check: no history lines collected; nothing to check");
    return;
  }

  // First pass: which trend (smaller-is-better) surfaces are drifting?
  const drifting: Array<{ surfaceId: BenchSurfaceId; slo: SloThreshold }> = [];
  for (const [surfaceId, { field, slo }] of TREND_METRIC_BY_SURFACE) {
    const series: DriftSample[] = historyLines
      .map((line) => {
        const surface: HistoryLineSurface | undefined = line.surfaces[surfaceId];
        if (surface === undefined) return null;
        const val = surface[field];
        return typeof val === "number" ? { value: val } : null;
      })
      .filter((s): s is DriftSample => s !== null);
    if (detectDrift(series, slo)) drifting.push({ surfaceId, slo });
  }
  if (drifting.length === 0) return; // no drift → no issue API calls at all

  // Fetch open drift issues once (best-effort: a list failure must not abort the
  // create path — worst case is a duplicate issue a human dedups).
  let existingIssues: GhIssue[] = [];
  try {
    existingIssues = await deps.gh.issueList({ label: DRIFT_ISSUE_LABEL });
  } catch (err) {
    stderr(`drift-check: gh issue list failed: ${errMsg(err)}; proceeding with none known`);
  }

  for (const { surfaceId, slo } of drifting) {
    stderr(`drift-check: drift detected on ${surfaceId} (${runner}); upserting gh issue`);
    try {
      await upsertDriftIssue(deps.gh, surfaceId, runner, slo, existingIssues, tmpRoot, stderr);
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
