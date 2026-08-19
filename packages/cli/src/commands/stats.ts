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

/**
 * Absent flag → `undefined` (the caller applies its own default). Present flag with no
 * value — either it is the last token, or the next token is itself another flag (starts
 * with `--`) — throws instead of returning `undefined`, so a terminal `--window` can never
 * fall through to `?? DEFAULT_WINDOW` and silently run with a value the user never typed.
 */
function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export type StatsArgs = {
  metric: string;
  service: string;
  windowMs: number;
  bucketMs: number;
  json: boolean;
};

/**
 * `parse-since.ts` is SHARED with `nimbus query --since`, where its message naming `--since`
 * is correct — so it is deliberately not changed. This command has no `--since` flag, so its
 * raw message would name a flag the user cannot have typed. Re-thrown here naming the flag
 * that actually failed, keeping the offending value.
 */
function parseDurationFlag(raw: string, flag: string): number {
  try {
    return parseSinceDurationToMs(raw);
  } catch {
    throw new Error(`Invalid ${flag} value "${raw}" (examples: 90d, 1w, 48h, 30m)`);
  }
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
    windowMs: parseDurationFlag(takeFlag(args, "--window") ?? DEFAULT_WINDOW, "--window"),
    bucketMs: parseDurationFlag(takeFlag(args, "--bucket") ?? DEFAULT_BUCKET, "--bucket"),
    json: args.includes("--json"),
  };
}

// --- metrics.stats response shape (validated at the IPC boundary — the gateway is a
// separate process, so its response arrives as `unknown`, never trusted blind).
//
// Field names are snake_case because the WIRE shape is: `metrics.stats` request params are
// `window_ms`/`bucket_ms` and the sibling `metrics.dora` response carries `since_ms` /
// `computed_at`. The gateway's `metrics/stats.ts` declares the same names. ---

export type StatsPoint = {
  readonly start_ms: number;
  readonly end_ms: number;
  readonly value: number | null;
  readonly unit: string;
  readonly sample: number;
  readonly gap: string | null;
};

export type StatsSeries = {
  readonly metric: string;
  readonly service: string;
  readonly window: { readonly since_ms: number; readonly until_ms: number };
  readonly bucket_ms: number;
  readonly points: readonly StatsPoint[];
};

function isStatsPoint(value: unknown): value is StatsPoint {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p["start_ms"] === "number" &&
    typeof p["end_ms"] === "number" &&
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
  if (typeof v["bucket_ms"] !== "number") return false;
  const w = v["window"];
  if (w === null || typeof w !== "object") return false;
  const win = w as Record<string, unknown>;
  if (typeof win["since_ms"] !== "number" || typeof win["until_ms"] !== "number") return false;
  const points = v["points"];
  return Array.isArray(points) && points.every(isStatsPoint);
}

// --- rendering ---

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Largest-unit-first so `604800000` prints `1w`, not `604800000ms`. */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["w", 7 * ONE_DAY_MS],
  ["d", ONE_DAY_MS],
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

/**
 * A sub-day bucket needs the time component or every row in the series carries an identical
 * label — `--bucket 6h` renders four rows all reading the same date, and `printHelp`
 * advertises `h`/`m`/`s`. Dates only above a day, where a time of `00:00` is noise.
 */
function formatBucketRange(startMs: number, endMs: number, withTime: boolean): string {
  const at = (ms: number): string => {
    const iso = new Date(ms).toISOString();
    return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
  };
  return `${at(startMs)} → ${at(endMs)}`;
}

/** Widest `formatBucketRange` output for each mode, so the value column stays aligned. */
function rangeColumnWidth(withTime: boolean): number {
  return withTime ? 35 : 23;
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

/** `"9 low_sample, 1 no_repos"` — most frequent first. Empty string when nothing is flagged. */
function gapReasons(points: readonly StatsPoint[]): string {
  return [...gapCounts(points)]
    .sort((a, b) => b[1] - a[1])
    .map(([gap, count]) => `${String(count)} ${gap}`)
    .join(", ");
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

/**
 * Rule 2: a summary line beneath the table. EMPTY buckets and CAVEATED ones are counted
 * separately and never merged: a gap next to a real value (`low_sample` on an `mttr` median
 * of two incidents, `github_only_merge_data`, `approximate_lead_time`, `mixed_source`) means
 * "this number, with a caveat", while a gap next to a `—` means "no number at all". Reporting
 * one combined count read as "N buckets had no data" and understated how many buckets
 * actually held a value.
 */
function summaryLine(points: readonly StatsPoint[]): string {
  const total = points.length;
  const withData = points.filter((p) => p.value !== null);
  const empty = points.filter((p) => p.value === null);
  const caveated = withData.filter((p) => p.gap !== null);
  let line = `${String(withData.length)} of ${String(total)} buckets had data`;
  if (caveated.length > 0) {
    line += ` (${String(caveated.length)} caveated: ${gapReasons(caveated)})`;
  }
  if (empty.length > 0) {
    const reasons = gapReasons(empty);
    line += ` · ${String(empty.length)} empty${reasons === "" ? "" : ` (${reasons})`}`;
  }
  return line;
}

export function renderStatsSeries(series: StatsSeries): string {
  const withTime = series.bucket_ms < ONE_DAY_MS;
  const lines: string[] = [];
  lines.push(`${series.metric} — ${series.service}`);
  lines.push(
    `window ${formatBucketRange(series.window.since_ms, series.window.until_ms, withTime)} · bucket ${formatDurationMs(series.bucket_ms)}`,
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

  const pad = rangeColumnWidth(withTime);
  for (const p of series.points) {
    // Rule 1: EVERY non-null gap is printed, whether or not the bucket also carries a value.
    // A caveated value (`mttr`'s median over two incidents is a real number carrying
    // `low_sample`) must not render as a bare number indistinguishable from a solid one. The
    // null/zero distinction is still carried by the value column itself — `—` for null,
    // never `0` — so showing the gap here blurs nothing.
    const gapCell = p.gap ?? "";
    lines.push(
      `  ${formatBucketRange(p.start_ms, p.end_ms, withTime).padEnd(pad)} ${formatStatsValue(p.value).padStart(10)} ${p.unit.padEnd(18)} n=${String(p.sample).padEnd(4)} ${gapCell}`.trimEnd(),
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
  table   (default) one row per bucket, plus a summary line splitting buckets that had data
          (some with a caveat gap) from buckets that were empty
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
