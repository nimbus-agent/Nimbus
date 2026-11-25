import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { forEachKeyValueInSection, parseBool, parseIntDec } from "./toml-primitives.ts";

/**
 * `[watcher.anomaly]` - the owner's notice of an unusual sync (Phase 10 carried item). DEFAULT OFF:
 * the detector scores sync telemetry either way, but only `notify = true` raises an OS notification
 * on this machine. A value out of range or malformed is a fallback to THAT KEY's default, recorded
 * through `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
export type NimbusAnomalyToml = {
  readonly notify: boolean;
  /** At most one notification per connector in this many minutes. */
  readonly minIntervalMinutes: number;
  /** Rolling z-score at or above which a sample is an anomaly. */
  readonly minScore: number;
};

export const ANOMALY_INTERVAL_MIN = 5;
export const ANOMALY_INTERVAL_MAX = 1440;
export const ANOMALY_SCORE_MIN = 3;
export const ANOMALY_SCORE_MAX = 20;

export const DEFAULT_ANOMALY_CONFIG: NimbusAnomalyToml = Object.freeze({
  notify: false,
  minIntervalMinutes: 60,
  minScore: 3,
});

type Draft = { -readonly [K in keyof NimbusAnomalyToml]: NimbusAnomalyToml[K] };

/** An integer key in `min..max`, else `fallback` (reported). */
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
    `[watcher.anomaly].${label} must be an integer ${String(min)}..${String(max)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

function applyKey(out: Draft, key: string, valRaw: string, report: (msg: string) => void): void {
  switch (key) {
    case "notify": {
      const b = parseBool(valRaw);
      if (b === undefined) {
        report(`[watcher.anomaly].notify must be true or false (got: ${valRaw}); using false`);
        out.notify = DEFAULT_ANOMALY_CONFIG.notify;
      } else out.notify = b;
      break;
    }
    case "min_interval_minutes":
      out.minIntervalMinutes = intInRange(
        valRaw,
        ANOMALY_INTERVAL_MIN,
        ANOMALY_INTERVAL_MAX,
        key,
        DEFAULT_ANOMALY_CONFIG.minIntervalMinutes,
        report,
      );
      break;
    case "min_score":
      out.minScore = intInRange(
        valRaw,
        ANOMALY_SCORE_MIN,
        ANOMALY_SCORE_MAX,
        key,
        DEFAULT_ANOMALY_CONFIG.minScore,
        report,
      );
      break;
    default:
      break;
  }
}

export function parseNimbusTomlAnomaly(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusAnomalyToml {
  const out: Draft = { ...DEFAULT_ANOMALY_CONFIG };
  forEachKeyValueInSection(source, "[watcher.anomaly]", (key, valRaw) =>
    applyKey(out, key, valRaw, (m) => onFallback?.(m)),
  );
  return Object.freeze(out);
}

/** `[watcher.anomaly]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusAnomalyFromConfigDir(configDir: string): NimbusAnomalyToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_ANOMALY_CONFIG;
  return parseNimbusTomlAnomaly(raw, sectionFallbackSink(configDir, "watcher.anomaly"));
}
