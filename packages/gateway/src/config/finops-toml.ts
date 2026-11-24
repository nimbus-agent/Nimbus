/**
 * `[finops]` - the FinOps cost-data limits (Phase 10, spec 2026-11-12-finops-connectors.md, OR-FO-5):
 * `max_series` is how many named series a cost connector indexes before folding the rest into
 * `__other__` (default 500), `retain_days` is how long `cost_allocation` rows are kept (default 400), `anomaly_ratio` (1.05 to 100,
 * default 1.5) and `anomaly_min_amount` (0 to 1e9, default 10) are the cost anomaly detector's thresholds.
 * `notify` (default false) raises a local OS notice when the detector finds a new anomaly, at most one per
 * `notify_min_interval_minutes` (5 to 1440, default 360).
 *
 * A value out of range or malformed is a section fallback to THAT KEY's default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export type NimbusFinopsToml = {
  readonly maxSeries: number;
  readonly retainDays: number;
  /** A day is anomalous when it is at least this many times its 7-day baseline (and passes the floor). */
  readonly anomalyRatio: number;
  /** ... and exceeds that baseline by at least this much, in the series' own currency. */
  readonly anomalyMinAmount: number;
  /** DEFAULT OFF: a local, counts-only OS notification when a new cost anomaly appears. */
  readonly notify: boolean;
  /** At most one cost notification in this many minutes. */
  readonly notifyMinIntervalMinutes: number;
};

export const FINOPS_MAX_SERIES_MIN = 1;
export const FINOPS_MAX_SERIES_MAX = 5000;
export const FINOPS_RETAIN_DAYS_MIN = 30;
export const FINOPS_RETAIN_DAYS_MAX = 3650;

export const FINOPS_ANOMALY_RATIO_MIN = 1.05;
export const FINOPS_ANOMALY_RATIO_MAX = 100;
export const FINOPS_ANOMALY_MIN_AMOUNT_MIN = 0;
export const FINOPS_ANOMALY_MIN_AMOUNT_MAX = 1_000_000_000;

export const FINOPS_NOTIFY_INTERVAL_MIN = 5;
export const FINOPS_NOTIFY_INTERVAL_MAX = 1440;

export const DEFAULT_FINOPS_CONFIG: NimbusFinopsToml = Object.freeze({
  maxSeries: 500,
  retainDays: 400,
  anomalyRatio: 1.5,
  anomalyMinAmount: 10,
  notify: false,
  notifyMinIntervalMinutes: 360,
});

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** A plain decimal (no sign, no exponent) in `min..max`, else the default (reported). */
function decimalInRange(
  raw: string,
  min: number,
  max: number,
  label: string,
  fallback: number,
  report: (msg: string) => void,
): number {
  const text = raw.trim();
  const n = DECIMAL.test(text) ? Number(text) : Number.NaN;
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  report(
    `${label} must be a number ${String(min)}..${String(max)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

/** An integer key in `min..max`, else the default (reported). */
function intInRange(
  raw: string,
  min: number,
  max: number,
  label: string,
  fallback: number,
  report: (msg: string) => void,
): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= min && n <= max) return n;
  report(
    `${label} must be an integer ${String(min)}..${String(max)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

type Draft = { -readonly [K in keyof NimbusFinopsToml]: NimbusFinopsToml[K] };

/** Apply one `[finops]` key to the draft; an unknown key is ignored, a bad value is reported and defaulted. */
function applyKey(out: Draft, key: string, raw: string, report: (msg: string) => void): void {
  const d = DEFAULT_FINOPS_CONFIG;
  switch (key) {
    case "max_series":
      out.maxSeries = intInRange(
        raw,
        FINOPS_MAX_SERIES_MIN,
        FINOPS_MAX_SERIES_MAX,
        "[finops].max_series",
        d.maxSeries,
        report,
      );
      break;
    case "retain_days":
      out.retainDays = intInRange(
        raw,
        FINOPS_RETAIN_DAYS_MIN,
        FINOPS_RETAIN_DAYS_MAX,
        "[finops].retain_days",
        d.retainDays,
        report,
      );
      break;
    case "anomaly_ratio":
      out.anomalyRatio = decimalInRange(
        raw,
        FINOPS_ANOMALY_RATIO_MIN,
        FINOPS_ANOMALY_RATIO_MAX,
        "[finops].anomaly_ratio",
        d.anomalyRatio,
        report,
      );
      break;
    case "anomaly_min_amount":
      out.anomalyMinAmount = decimalInRange(
        raw,
        FINOPS_ANOMALY_MIN_AMOUNT_MIN,
        FINOPS_ANOMALY_MIN_AMOUNT_MAX,
        "[finops].anomaly_min_amount",
        d.anomalyMinAmount,
        report,
      );
      break;
    case "notify": {
      const b = parseBool(raw);
      if (b === undefined)
        report(`[finops].notify must be true or false (got: ${raw}); using false`);
      out.notify = b ?? d.notify;
      break;
    }
    case "notify_min_interval_minutes":
      out.notifyMinIntervalMinutes = intInRange(
        raw,
        FINOPS_NOTIFY_INTERVAL_MIN,
        FINOPS_NOTIFY_INTERVAL_MAX,
        "[finops].notify_min_interval_minutes",
        d.notifyMinIntervalMinutes,
        report,
      );
      break;
    default:
      break;
  }
}

/** Parse `[finops]`. A bad value reports through `onFallback`. */
export function parseNimbusTomlFinops(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusFinopsToml {
  const report = (msg: string): void => onFallback?.(msg);
  const out: Draft = { ...DEFAULT_FINOPS_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[finops]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyKey(out, kv.key, kv.valRaw, report);
  }
  return Object.freeze(out);
}

/** `[finops]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusFinopsFromConfigDir(configDir: string): NimbusFinopsToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_FINOPS_CONFIG;
  return parseNimbusTomlFinops(raw, sectionFallbackSink(configDir, "finops"));
}
