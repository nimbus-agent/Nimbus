import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseIntDec, splitKeyValue, stripComment } from "./toml-primitives.ts";

/**
 * `[index]` - local index settings (Phase 10 IC1, incident-engine spec § 5.1). The section is new in IC1
 * and today holds one key:
 *
 * - `history_retention_days` (default 180, `7..3650`): how long `item_history` rows are kept. The daily
 *   prune (`index/item-history-retention.ts`) deletes older rows in batches. `0` is NOT "disabled", unlike
 *   `[audit] tool_call_log_retention_days`: an unbounded history table is not a mode this project offers.
 *
 * - `schema_history_retention_days` (default 365, `7..3650`): how long warehouse column-set observations
 *   (`schema_history`, the Data Incident Brief's schema diff) are kept. The newest observation of each table is
 *   always kept, because the next diff is taken against it.
 *
 * A value out of range or malformed is a section fallback to the default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
export type NimbusIndexToml = {
  readonly historyRetentionDays: number;
  readonly schemaHistoryRetentionDays: number;
};

export const INDEX_HISTORY_RETENTION_MIN = 7;
export const INDEX_HISTORY_RETENTION_MAX = 3650;

export const DEFAULT_INDEX_CONFIG: NimbusIndexToml = Object.freeze({
  historyRetentionDays: 180,
  schemaHistoryRetentionDays: 365,
});

function retentionOrDefault(
  key: string,
  raw: string,
  fallback: number,
  onFallback: SectionFallbackSink | undefined,
): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= INDEX_HISTORY_RETENTION_MIN && n <= INDEX_HISTORY_RETENTION_MAX) {
    return n;
  }
  onFallback?.(
    `[index].${key} must be an integer ${String(INDEX_HISTORY_RETENTION_MIN)}..${String(INDEX_HISTORY_RETENTION_MAX)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

/** Parse `[index]`. A bad value reports through `onFallback`. `[index.*]` sub-tables are ignored. */
export function parseNimbusTomlIndex(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIndexToml {
  let inIndex = false;
  let historyRetentionDays = DEFAULT_INDEX_CONFIG.historyRetentionDays;
  let schemaHistoryRetentionDays = DEFAULT_INDEX_CONFIG.schemaHistoryRetentionDays;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inIndex = trimmed === "[index]";
      continue;
    }
    if (!inIndex) continue;
    const kv = splitKeyValue(trimmed);
    if (kv?.key === "history_retention_days") {
      historyRetentionDays = retentionOrDefault(
        kv.key,
        kv.valRaw,
        DEFAULT_INDEX_CONFIG.historyRetentionDays,
        onFallback,
      );
    } else if (kv?.key === "schema_history_retention_days") {
      schemaHistoryRetentionDays = retentionOrDefault(
        kv.key,
        kv.valRaw,
        DEFAULT_INDEX_CONFIG.schemaHistoryRetentionDays,
        onFallback,
      );
    }
  }
  return Object.freeze({ historyRetentionDays, schemaHistoryRetentionDays });
}

/** `[index]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusIndexFromConfigDir(configDir: string): NimbusIndexToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_INDEX_CONFIG;
  return parseNimbusTomlIndex(raw, sectionFallbackSink(configDir, "index"));
}
