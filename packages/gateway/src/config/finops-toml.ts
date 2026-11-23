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

/** Parse `[finops]`. A bad value reports through `onFallback`. */
export function parseNimbusTomlFinops(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusFinopsToml {
  const report = (msg: string): void => onFallback?.(msg);
  let maxSeries = DEFAULT_FINOPS_CONFIG.maxSeries;
  let retainDays = DEFAULT_FINOPS_CONFIG.retainDays;
  let anomalyRatio = DEFAULT_FINOPS_CONFIG.anomalyRatio;
  let anomalyMinAmount = DEFAULT_FINOPS_CONFIG.anomalyMinAmount;
  let notify = DEFAULT_FINOPS_CONFIG.notify;
  let notifyMinIntervalMinutes = DEFAULT_FINOPS_CONFIG.notifyMinIntervalMinutes;
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
    if (kv === undefined) continue;
    if (kv.key === "max_series") {
      maxSeries = intInRange(
        kv.valRaw,
        FINOPS_MAX_SERIES_MIN,
        FINOPS_MAX_SERIES_MAX,
        "[finops].max_series",
        DEFAULT_FINOPS_CONFIG.maxSeries,
        report,
      );
    } else if (kv.key === "retain_days") {
      retainDays = intInRange(
        kv.valRaw,
        FINOPS_RETAIN_DAYS_MIN,
        FINOPS_RETAIN_DAYS_MAX,
        "[finops].retain_days",
        DEFAULT_FINOPS_CONFIG.retainDays,
        report,
      );
    } else if (kv.key === "anomaly_ratio") {
      anomalyRatio = decimalInRange(
        kv.valRaw,
        FINOPS_ANOMALY_RATIO_MIN,
        FINOPS_ANOMALY_RATIO_MAX,
        "[finops].anomaly_ratio",
        DEFAULT_FINOPS_CONFIG.anomalyRatio,
        report,
      );
    } else if (kv.key === "anomaly_min_amount") {
      anomalyMinAmount = decimalInRange(
        kv.valRaw,
        FINOPS_ANOMALY_MIN_AMOUNT_MIN,
        FINOPS_ANOMALY_MIN_AMOUNT_MAX,
        "[finops].anomaly_min_amount",
        DEFAULT_FINOPS_CONFIG.anomalyMinAmount,
        report,
      );
    } else if (kv.key === "notify") {
      const b = parseBool(kv.valRaw);
      if (b === undefined)
        report(`[finops].notify must be true or false (got: ${kv.valRaw}); using false`);
      notify = b ?? DEFAULT_FINOPS_CONFIG.notify;
    } else if (kv.key === "notify_min_interval_minutes") {
      notifyMinIntervalMinutes = intInRange(
        kv.valRaw,
        FINOPS_NOTIFY_INTERVAL_MIN,
        FINOPS_NOTIFY_INTERVAL_MAX,
        "[finops].notify_min_interval_minutes",
        DEFAULT_FINOPS_CONFIG.notifyMinIntervalMinutes,
        report,
      );
    }
  }
  return Object.freeze({
    maxSeries,
    retainDays,
    anomalyRatio,
    anomalyMinAmount,
    notify,
    notifyMinIntervalMinutes,
  });
}

/** `[finops]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusFinopsFromConfigDir(configDir: string): NimbusFinopsToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_FINOPS_CONFIG;
  return parseNimbusTomlFinops(raw, sectionFallbackSink(configDir, "finops"));
}
