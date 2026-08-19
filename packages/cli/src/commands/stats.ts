import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

const METRICS = [
  "deployment-frequency",
  "lead-time",
  "change-failure-rate",
  "mttr",
  "pr-merges",
  "incidents-opened",
] as const;

const DEFAULT_WINDOW = "90d";
const DEFAULT_BUCKET = "1w";

export type StatsArgs = {
  metric: string;
  service: string;
  windowMs: number;
  bucketMs: number;
  json: boolean;
};

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

/**
 * Durations are parsed HERE, CLI-side. `metrics.stats` receives resolved integers and never
 * re-parses a string — deliberately, because the gateway holds two narrower parsers
 * (`ipc/metrics-rpc.ts`'s `parseSinceToMs` accepts `d|h` only; `index/item-list-query.ts`'s
 * `parseRelativeSinceToWindowMs` has no `w`) and either would reject this command's own
 * `1w` default.
 */
export function parseStatsArgs(args: string[]): StatsArgs {
  const metric = args[0];
  if (metric === undefined || metric.startsWith("--")) {
    throw new Error(`Usage: nimbus stats <${METRICS.join("|")}> --service <id>`);
  }
  const service = takeFlag(args, "--service");
  if (service === undefined || service.trim() === "") {
    throw new Error("Missing --service <id>");
  }
  return {
    metric,
    service: service.trim(),
    windowMs: parseSinceDurationToMs(takeFlag(args, "--window") ?? DEFAULT_WINDOW),
    bucketMs: parseSinceDurationToMs(takeFlag(args, "--bucket") ?? DEFAULT_BUCKET),
    json: args.includes("--json"),
  };
}

// --- metrics.stats response shape (validated at the IPC boundary — the gateway is a
// separate process, so its response arrives as `unknown`, never trusted blind). ---

export type StatsPoint = {
  readonly startMs: number;
  readonly endMs: number;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: string | null;
};

export type StatsSeries = {
  readonly metric: string;
  readonly service: string;
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly bucketMs: number;
  readonly points: readonly StatsPoint[];
};

function isStatsPoint(value: unknown): value is StatsPoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p["startMs"] === "number" &&
    typeof p["endMs"] === "number" &&
    (p["value"] === null || typeof p["value"] === "number") &&
    typeof p["unit"] === "string" &&
    typeof p["sample"] === "number" &&
    (p["gap"] === null || typeof p["gap"] === "string")
  );
}

function isStatsSeries(value: unknown): value is StatsSeries {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v["metric"] !== "string" || typeof v["service"] !== "string") return false;
  if (typeof v["bucketMs"] !== "number") return false;
  const w = v["window"];
  if (w === null || typeof w !== "object") return false;
  const win = w as Record<string, unknown>;
  if (typeof win["sinceMs"] !== "number" || typeof win["untilMs"] !== "number") return false;
  const points = v["points"];
  return Array.isArray(points) && points.every(isStatsPoint);
}

// --- rendering ---

/** Largest-unit-first so `604800000` prints `1w`, not `604800000ms`. */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["w", 7 * 24 * 60 * 60 * 1000],
  ["d", 24 * 60 * 60 * 1000],
  ["h", 60 * 60 * 1000],
  ["m", 60 * 1000],
  ["s", 1000],
];

function formatDurationMs(ms: number): string {
  for (const [unit, unitMs] of DURATION_UNITS) {
    if (ms >= unitMs && ms % unitMs === 0) {
      return `${String(ms / unitMs)}${unit}`;
    }
  }
  return `${String(ms)}ms`;
}

function formatBucketRange(startMs: number, endMs: number): string {
  const s = new Date(startMs).toISOString().slice(0, 10);
  const e = new Date(endMs).toISOString().slice(0, 10);
  return `${s} → ${e}`;
}

/**
 * A `null` value renders as `—`, never `0` — that distinction is the entire point of the
 * null (zero incidents and no incident data are different facts). A present numeric value
 * is never routed through this "no data" glyph on any branch.
 */
function formatStatsValue(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function gapCounts(points: readonly StatsPoint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of points) {
    if (p.gap === null) continue;
    counts.set(p.gap, (counts.get(p.gap) ?? 0) + 1);
  }
  return counts;
}

function dominantGap(points: readonly StatsPoint[]): string | undefined {
  let best: { gap: string; count: number } | undefined;
  for (const [gap, count] of gapCounts(points)) {
    if (best === undefined || count > best.count) {
      best = { gap, count };
    }
  }
  return best?.gap;
}

/** Rule 2: a summary line beneath the table — how many buckets had data, plus why the rest didn't. */
function summaryLine(points: readonly StatsPoint[]): string {
  const total = points.length;
  const withValue = points.filter((p) => p.value !== null).length;
  const reasons = [...gapCounts(points)]
    .sort((a, b) => b[1] - a[1])
    .map(([gap, count]) => `${String(count)} ${gap}`)
    .join(", ");
  const base = `${String(withValue)} of ${String(total)} buckets had data`;
  return reasons === "" ? base : `${base} (${reasons})`;
}

export function renderStatsSeries(series: StatsSeries): string {
  const lines: string[] = [];
  lines.push(`${series.metric} — ${series.service}`);
  lines.push(
    `window ${formatBucketRange(series.window.sinceMs, series.window.untilMs)} · bucket ${formatDurationMs(series.bucketMs)}`,
    "",
  );

  const total = series.points.length;
  const withValue = series.points.filter((p) => p.value !== null).length;

  // Rule 3: every bucket null → one plain sentence naming the dominant gap, not a wall of dashes.
  if (total > 0 && withValue === 0) {
    const gap = dominantGap(series.points);
    lines.push(
      gap === undefined
        ? `No data: all ${String(total)} buckets are empty.`
        : `No data: all ${String(total)} buckets are empty (dominant gap: ${gap}).`,
    );
    return lines.join("\n");
  }

  if (total === 0) {
    lines.push("(no buckets in this window)");
    return lines.join("\n");
  }

  for (const p of series.points) {
    // Rule 1: the gap column is populated only when the value is null — a caveat gap next to
    // a real value (e.g. `github_only_merge_data`) is not printed per-row. `summaryLine`
    // still counts it, via `gapCounts`, which counts every non-null gap regardless of
    // whether its bucket also carries a value.
    const gapCell = p.value === null && p.gap !== null ? p.gap : "";
    lines.push(
      `  ${formatBucketRange(p.startMs, p.endMs).padEnd(23)} ${formatStatsValue(p.value).padStart(10)} ${p.unit.padEnd(18)} n=${String(p.sample).padEnd(4)} ${gapCell}`,
    );
  }

  lines.push("", summaryLine(series.points));
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`nimbus stats <metric> --service <id> — bucketed time series over the local index

Usage:
  nimbus stats <${METRICS.join("|")}> --service <id> [--window 90d] [--bucket 1w] [--json]

Durations (--window / --bucket) accept: w d h m s ms  (e.g. 90d, 1w, 48h)

Output:
  table   (default) one row per bucket, plus a summary line of how many buckets had data
  --json  raw metrics.stats response, verbatim, with no summary
`);
}

export async function runStats(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const parsed = parseStatsArgs(args);

  const result = await withGatewayIpc((c) =>
    c.call<unknown>("metrics.stats", {
      service: parsed.service,
      metric: parsed.metric,
      window_ms: parsed.windowMs,
      bucket_ms: parsed.bucketMs,
    }),
  );

  if (!isStatsSeries(result)) {
    throw new Error("Malformed metrics.stats response");
  }

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(renderStatsSeries(result));
}
