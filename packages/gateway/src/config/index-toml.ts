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
 * A value out of range or malformed is a section fallback to the default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
export type NimbusIndexToml = {
  readonly historyRetentionDays: number;
};

export const INDEX_HISTORY_RETENTION_MIN = 7;
export const INDEX_HISTORY_RETENTION_MAX = 3650;

export const DEFAULT_INDEX_CONFIG: NimbusIndexToml = Object.freeze({ historyRetentionDays: 180 });

function retentionOrDefault(raw: string, onFallback: SectionFallbackSink | undefined): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= INDEX_HISTORY_RETENTION_MIN && n <= INDEX_HISTORY_RETENTION_MAX) {
    return n;
  }
  onFallback?.(
    `[index].history_retention_days must be an integer ${String(INDEX_HISTORY_RETENTION_MIN)}..${String(INDEX_HISTORY_RETENTION_MAX)} (got: ${raw}); using ${String(DEFAULT_INDEX_CONFIG.historyRetentionDays)}`,
  );
  return DEFAULT_INDEX_CONFIG.historyRetentionDays;
}

/** Parse `[index]`. A bad value reports through `onFallback`. `[index.*]` sub-tables are ignored. */
export function parseNimbusTomlIndex(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIndexToml {
  let inIndex = false;
  let historyRetentionDays = DEFAULT_INDEX_CONFIG.historyRetentionDays;
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
      historyRetentionDays = retentionOrDefault(kv.valRaw, onFallback);
    }
  }
  return Object.freeze({ historyRetentionDays });
}

/** `[index]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusIndexFromConfigDir(configDir: string): NimbusIndexToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_INDEX_CONFIG;
  return parseNimbusTomlIndex(raw, sectionFallbackSink(configDir, "index"));
}
