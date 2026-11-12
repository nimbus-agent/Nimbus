/**
 * `[finops]` - the FinOps cost-data limits (Phase 10, spec 2026-11-12-finops-connectors.md, OR-FO-5):
 * `max_series` is how many named series a cost connector indexes before folding the rest into
 * `__other__` (default 500), `retain_days` is how long `cost_allocation` rows are kept (default 400).
 *
 * A value out of range or malformed is a section fallback to THAT KEY's default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseIntDec, splitKeyValue, stripComment } from "./toml-primitives.ts";

export type NimbusFinopsToml = {
  readonly maxSeries: number;
  readonly retainDays: number;
};

export const FINOPS_MAX_SERIES_MIN = 1;
export const FINOPS_MAX_SERIES_MAX = 5000;
export const FINOPS_RETAIN_DAYS_MIN = 30;
export const FINOPS_RETAIN_DAYS_MAX = 3650;

export const DEFAULT_FINOPS_CONFIG: NimbusFinopsToml = Object.freeze({
  maxSeries: 500,
  retainDays: 400,
});

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
    }
  }
  return Object.freeze({ maxSeries, retainDays });
}

/** `[finops]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusFinopsFromConfigDir(configDir: string): NimbusFinopsToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_FINOPS_CONFIG;
  return parseNimbusTomlFinops(raw, sectionFallbackSink(configDir, "finops"));
}
