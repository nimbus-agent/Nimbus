/**
 * `[orchestration]` - the retention of orchestration RUN rows (`airflow:dag_run`, `dagster:job_run`,
 * `prefect:flow_run`, the Data Incident Brief's DAG-run input). `run_retention_days` (default 30, `7..365`):
 * a run that ended (or started, when it has no end) longer ago than this is deleted by a daily pass
 * (`index/orchestration-run-retention.ts`). The DAG, job and deployment rows are never pruned by it. `0` is not
 * "off": an unbounded run table is not a mode this project offers.
 *
 * A value out of range or malformed falls back to the default, recorded through `sectionFallbackSink` so
 * `nimbus config explain` names it; it is never clamped.
 */
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseIntDec, splitKeyValue, stripComment } from "./toml-primitives.ts";

export type NimbusOrchestrationToml = {
  readonly runRetentionDays: number;
};

export const ORCHESTRATION_RUN_RETENTION_MIN = 7;
export const ORCHESTRATION_RUN_RETENTION_MAX = 365;

export const DEFAULT_ORCHESTRATION_CONFIG: NimbusOrchestrationToml = Object.freeze({
  runRetentionDays: 30,
});

function retentionOrDefault(raw: string, onFallback: SectionFallbackSink | undefined): number {
  const n = parseIntDec(raw);
  if (
    n !== undefined &&
    n >= ORCHESTRATION_RUN_RETENTION_MIN &&
    n <= ORCHESTRATION_RUN_RETENTION_MAX
  ) {
    return n;
  }
  onFallback?.(
    `[orchestration].run_retention_days must be an integer ${String(ORCHESTRATION_RUN_RETENTION_MIN)}..${String(ORCHESTRATION_RUN_RETENTION_MAX)} (got: ${raw}); using ${String(DEFAULT_ORCHESTRATION_CONFIG.runRetentionDays)}`,
  );
  return DEFAULT_ORCHESTRATION_CONFIG.runRetentionDays;
}

/** Parse `[orchestration]`. A bad value reports through `onFallback`. */
export function parseNimbusTomlOrchestration(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusOrchestrationToml {
  let inSection = false;
  let runRetentionDays = DEFAULT_ORCHESTRATION_CONFIG.runRetentionDays;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[orchestration]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv?.key === "run_retention_days") {
      runRetentionDays = retentionOrDefault(kv.valRaw, onFallback);
    }
  }
  return Object.freeze({ runRetentionDays });
}

/** `[orchestration]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusOrchestrationFromConfigDir(configDir: string): NimbusOrchestrationToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_ORCHESTRATION_CONFIG;
  return parseNimbusTomlOrchestration(raw, sectionFallbackSink(configDir, "orchestration"));
}
