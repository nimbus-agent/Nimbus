import { hostname, platform, release } from "node:os";

import { runBench } from "./bench-harness.ts";
import { appendHistoryLine, type HistoryLine, type HistoryLineSurface } from "./history-line.ts";
import { runCliOverheadColdOnce } from "./surfaces/bench-cli-overhead-cold.ts";
import { runCliOverheadWarmOnce } from "./surfaces/bench-cli-overhead-warm.ts";
import { runColdStartOnce } from "./surfaces/bench-cold-start.ts";
import {
  runDashboardFirstPaintOnce,
  S3_STUB_REASON,
} from "./surfaces/bench-dashboard-first-paint.ts";
import { runEmbeddingThroughputOnce } from "./surfaces/bench-embedding-throughput.ts";
import { runHitlPopupOnce, S5_STUB_REASON } from "./surfaces/bench-hitl-popup.ts";
import { runLlmRoundtripOnce, S9_STUB_REASON } from "./surfaces/bench-llm-roundtrip.ts";
import { runQueryLatencyOnce } from "./surfaces/bench-query-latency.ts";
import { runQueryLatency1mOnce } from "./surfaces/bench-query-latency-1m.ts";
import { runQueryLatency100kOnce } from "./surfaces/bench-query-latency-100k.ts";
import { runRssHeavySyncOnce } from "./surfaces/bench-rss-heavy-sync.ts";
import { runRssIdleOnce } from "./surfaces/bench-rss-idle.ts";
import {
  runRssMultiAgentOnce,
  S7C_REFERENCE_ONLY_REASON,
} from "./surfaces/bench-rss-multi-agent.ts";
import { runSqliteContentionOnce, S10_BUSY_RETRIES } from "./surfaces/bench-sqlite-contention.ts";
import { runSyncThroughputDriveOnce } from "./surfaces/bench-sync-throughput-drive.ts";
import { runSyncThroughputGithubOnce } from "./surfaces/bench-sync-throughput-github.ts";
import { runSyncThroughputGmailOnce } from "./surfaces/bench-sync-throughput-gmail.ts";
import { runTuiFirstPaintOnce } from "./surfaces/bench-tui-first-paint.ts";
import {
  type BenchResultKind,
  type BenchRunOptions,
  type BenchSurfaceId,
  type BenchSurfaceResult,
  type RunnerKind,
  S8_BATCHES,
  S8_LENGTHS,
} from "./types.ts";

export interface BenchCliDeps {
  runId: string;
  historyPath: string;
  fixtureCacheDir?: string;
  stdout: (s: string) => void;
  stderr?: (s: string) => void;
  confirmReferenceProtocol?: () => boolean | Promise<boolean>;
  resolveGitSha?: () => string;
  surfaceDriverOverrides?: Partial<Record<BenchSurfaceId, DriverFn>>;
}

type DriverFn = (opts: BenchRunOptions, runOpts: { cacheDir?: string }) => Promise<number[]>;

const SURFACE_REGISTRY: Partial<Record<BenchSurfaceId, DriverFn>> = {
  S1: (opts) => runColdStartOnce(opts),
  "S2-a": (opts, runOpts) => runQueryLatencyOnce(opts, runOpts),
  "S2-b": (opts, runOpts) => runQueryLatency100kOnce(opts, runOpts),
  "S2-c": (opts, runOpts) => runQueryLatency1mOnce(opts, runOpts),
  S3: (opts) => runDashboardFirstPaintOnce(opts),
  S4: (opts) => runTuiFirstPaintOnce(opts),
  S5: (opts) => runHitlPopupOnce(opts),
  "S6-drive": (opts) => runSyncThroughputDriveOnce(opts),
  "S6-gmail": (opts) => runSyncThroughputGmailOnce(opts),
  "S6-github": (opts) => runSyncThroughputGithubOnce(opts),
  "S7-a": (opts) => runRssIdleOnce(opts),
  "S7-b": (opts) => runRssHeavySyncOnce(opts),
  "S7-c": (opts) => runRssMultiAgentOnce(opts),
  S9: (opts) => runLlmRoundtripOnce(opts),
  S10: (opts) => runSqliteContentionOnce(opts),
  "S11-a": (opts) => runCliOverheadColdOnce(opts),
  "S11-b": (opts) => runCliOverheadWarmOnce(opts),
};
for (const length of S8_LENGTHS) {
  for (const batch of S8_BATCHES) {
    const id = `S8-l${length}-b${batch}` as BenchSurfaceId;
    SURFACE_REGISTRY[id] = (opts) =>
      runEmbeddingThroughputOnce({
        length,
        batch,
        ...(opts.corpus !== undefined && { corpus: opts.corpus }),
      });
  }
}

const SURFACE_RESULT_KIND: Partial<Record<BenchSurfaceId, BenchResultKind>> = {
  "S6-drive": "throughput",
  "S6-gmail": "throughput",
  "S6-github": "throughput",
  "S7-a": "rss",
  "S7-b": "rss",
  "S7-c": "rss",
  S10: "throughput",
  // Latency surfaces (S1, S2-*, S4, S11-*) omit and default to "latency".
};
for (const length of S8_LENGTHS) {
  for (const batch of S8_BATCHES) {
    SURFACE_RESULT_KIND[`S8-l${length}-b${batch}` as BenchSurfaceId] = "throughput";
  }
}

const STUB_SURFACES: Partial<Record<BenchSurfaceId, string>> = {
  S3: S3_STUB_REASON,
  S5: S5_STUB_REASON,
  S9: S9_STUB_REASON,
};

const REFERENCE_ONLY: ReadonlySet<BenchSurfaceId> = new Set<BenchSurfaceId>(["S2-c", "S7-c", "S9"]);

const REFERENCE_ONLY_REASONS: Partial<Record<BenchSurfaceId, string>> = {
  "S7-c": S7C_REFERENCE_ONLY_REASON,
};

export const LINUX_ONLY_THRESHOLDS: ReadonlySet<BenchSurfaceId> = new Set<BenchSurfaceId>([
  "S7-a",
  "S7-b",
  "S7-c",
]);

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function detectRunner(args: string[]): RunnerKind {
  if (hasFlag(args, "--reference")) return "reference-m1air";
  if (hasFlag(args, "--gha")) {
    if (process.platform === "darwin") return "gha-macos";
    if (process.platform === "win32") return "gha-windows";
    return "gha-ubuntu";
  }
  return "local-dev";
}

function defaultConfirm(): boolean {
  return false;
}

function defaultResolveGitSha(): string {
  return process.env["GITHUB_SHA"] ?? "unknown";
}

function resultToHistorySurface(r: BenchSurfaceResult): HistoryLineSurface {
  const out: HistoryLineSurface = { samples_count: r.samplesCount };
  if (r.p50Ms !== undefined) out.p50_ms = r.p50Ms;
  if (r.p95Ms !== undefined) out.p95_ms = r.p95Ms;
  if (r.p99Ms !== undefined) out.p99_ms = r.p99Ms;
  if (r.maxMs !== undefined) out.max_ms = r.maxMs;
  if (r.throughputPerSec !== undefined) out.throughput_per_sec = r.throughputPerSec;
  if (r.tokensPerSec !== undefined) out.tokens_per_sec = r.tokensPerSec;
  if (r.firstTokenMs !== undefined) out.first_token_ms = r.firstTokenMs;
  if (r.rssBytesP95 !== undefined) out.rss_bytes_p95 = r.rssBytesP95;
  if (r.busyRetries !== undefined) out.busy_retries = r.busyRetries;
  return out;
}

function resolveSurfaces(args: string[], surfaceArg: string | undefined): BenchSurfaceId[] {
  if (hasFlag(args, "--all")) return Object.keys(SURFACE_REGISTRY) as BenchSurfaceId[];
  if (surfaceArg !== undefined) return [surfaceArg as BenchSurfaceId];
  return [];
}

function parseCorpus(arg: string | undefined): "small" | "medium" | "large" | undefined {
  return arg === "small" || arg === "medium" || arg === "large" ? arg : undefined;
}

function buildBenchOpts(args: string[], runner: RunnerKind): BenchRunOptions {
  const runsArg = takeFlag(args, "--runs");
  const runs = runsArg === undefined ? 5 : Number.parseInt(runsArg, 10);
  const corpus = parseCorpus(takeFlag(args, "--corpus"));
  return {
    runs: Number.isFinite(runs) && runs > 0 ? runs : 5,
    runner,
    ...(corpus !== undefined && { corpus }),
  };
}

type SurfaceOutcome =
  | { kind: "result"; entry: HistoryLineSurface; stdoutLine: string; stderrLine?: string }
  | { kind: "abort"; reason: string };

async function processSurface(
  id: BenchSurfaceId,
  opts: BenchRunOptions,
  runner: RunnerKind,
  deps: BenchCliDeps,
): Promise<SurfaceOutcome> {
  const stubReason = STUB_SURFACES[id];
  if (stubReason !== undefined) {
    return {
      kind: "result",
      entry: { samples_count: 0, stub_reason: stubReason },
      stdoutLine: `${id}  stub: ${stubReason}`,
    };
  }

  if (REFERENCE_ONLY.has(id) && runner !== "reference-m1air") {
    const reason = REFERENCE_ONLY_REASONS[id] ?? `reference-only — skipped on ${runner}`;
    return {
      kind: "result",
      entry: { samples_count: 0, stub_reason: reason },
      stdoutLine: `${id}  skipped: ${reason}`,
    };
  }

  const driver = deps.surfaceDriverOverrides?.[id] ?? SURFACE_REGISTRY[id];
  if (driver === undefined) {
    return { kind: "abort", reason: `Surface ${id} has no driver registered yet (PR-B-2b work).` };
  }
  const runOpts = deps.fixtureCacheDir === undefined ? {} : { cacheDir: deps.fixtureCacheDir };

  let result: BenchSurfaceResult;
  try {
    const resultKind = SURFACE_RESULT_KIND[id] ?? "latency";
    if (id === "S10") {
      S10_BUSY_RETRIES.value = 0;
    }
    result = await runBench(id, (o) => driver(o, runOpts), opts, {}, resultKind);
    if (id === "S10") {
      result = { ...result, busyRetries: S10_BUSY_RETRIES.value };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "result",
      entry: { samples_count: 0, stub_reason: `driver-failed: ${msg}` },
      stdoutLine: `${id}  failed: ${msg}`,
      stderrLine: `${id} driver failed: ${msg}`,
    };
  }

  return {
    kind: "result",
    entry: resultToHistorySurface(result),
    stdoutLine: `${id}  p95=${result.p95Ms?.toFixed(2) ?? "-"}ms  p99=${result.p99Ms?.toFixed(2) ?? "-"}ms  samples=${result.samplesCount}`,
  };
}

function buildHistoryLine(
  deps: BenchCliDeps,
  runner: RunnerKind,
  surfaceResults: Record<string, HistoryLineSurface>,
): HistoryLine {
  const resolveGitSha = deps.resolveGitSha ?? defaultResolveGitSha;
  return {
    schema_version: 1,
    run_id: deps.runId,
    timestamp: new Date().toISOString(),
    runner,
    os_version: `${platform()} ${release()} (${hostname()})`,
    nimbus_git_sha: resolveGitSha(),
    bun_version: typeof Bun === "undefined" ? "unknown" : Bun.version,
    surfaces: surfaceResults as Partial<Record<BenchSurfaceId, HistoryLineSurface>>,
    ...(runner === "reference-m1air" && { reference_protocol_compliant: true }),
  };
}

export async function runBenchCli(args: string[], deps: BenchCliDeps): Promise<number> {
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const runner = detectRunner(args);
  const opts = buildBenchOpts(args, runner);

  if (runner === "reference-m1air") {
    const confirm = deps.confirmReferenceProtocol ?? defaultConfirm;
    if (!(await confirm())) {
      stderr("Reference-run protocol checklist not confirmed. Refusing to record. See spec §4.2.");
      return 2;
    }
  }

  const surfaces = resolveSurfaces(args, takeFlag(args, "--surface"));
  if (surfaces.length === 0) {
    stderr(
      `Pass --surface <id> or --all. Available surfaces: ${Object.keys(SURFACE_REGISTRY).join(", ")}`,
    );
    return 2;
  }

  const surfaceResults: Record<string, HistoryLineSurface> = {};
  for (const id of surfaces) {
    const outcome = await processSurface(id, opts, runner, deps);
    if (outcome.kind === "abort") {
      stderr(outcome.reason);
      return 2;
    }
    surfaceResults[id] = outcome.entry;
    deps.stdout(outcome.stdoutLine);
    if (outcome.stderrLine !== undefined) stderr(outcome.stderrLine);
  }

  appendHistoryLine(deps.historyPath, buildHistoryLine(deps, runner, surfaceResults));
  return 0;
}
