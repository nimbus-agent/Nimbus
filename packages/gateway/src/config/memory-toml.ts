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

/**
 * `[memory]` - long-term episodic memory (Phase 10, owner ruling OR-S4-MEM, invariant I61).
 *
 * - `episodic` (default `false`): opt in. Off, the gateway records nothing, summarises nothing and recalls
 *   nothing; the owner's `nimbus memory list` / `forget` still work on whatever is stored.
 * - `retention_days` (default 90, `7..365`): how long a stored memory lives. Pruned daily.
 *
 * A malformed or out-of-range value is a section fallback to the default (never clamped), recorded
 * through `sectionFallbackSink` so `nimbus config explain` names it.
 */
export type NimbusMemoryToml = {
  readonly episodic: boolean;
  readonly retentionDays: number;
};

export const MEMORY_RETENTION_MIN = 7;
export const MEMORY_RETENTION_MAX = 365;

export const DEFAULT_MEMORY_CONFIG: NimbusMemoryToml = Object.freeze({
  episodic: false,
  retentionDays: 90,
});

function retentionOrDefault(raw: string, onFallback: SectionFallbackSink | undefined): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= MEMORY_RETENTION_MIN && n <= MEMORY_RETENTION_MAX) return n;
  onFallback?.(
    `[memory].retention_days must be an integer ${String(MEMORY_RETENTION_MIN)}..${String(MEMORY_RETENTION_MAX)} (got: ${raw}); using ${String(DEFAULT_MEMORY_CONFIG.retentionDays)}`,
  );
  return DEFAULT_MEMORY_CONFIG.retentionDays;
}

export function parseNimbusTomlMemory(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusMemoryToml {
  let inSection = false;
  let episodic = DEFAULT_MEMORY_CONFIG.episodic;
  let retentionDays = DEFAULT_MEMORY_CONFIG.retentionDays;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[memory]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    if (kv.key === "episodic") {
      const b = parseBool(kv.valRaw);
      if (b === undefined) {
        onFallback?.(`[memory].episodic must be true or false (got: ${kv.valRaw}); using false`);
        episodic = false;
      } else episodic = b;
    } else if (kv.key === "retention_days") {
      retentionDays = retentionOrDefault(kv.valRaw, onFallback);
    }
  }
  return Object.freeze({ episodic, retentionDays });
}

/** `[memory]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusMemoryFromConfigDir(configDir: string): NimbusMemoryToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_MEMORY_CONFIG;
  return parseNimbusTomlMemory(raw, sectionFallbackSink(configDir, "memory"));
}
