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
 * - `recall_remote` (default `false`, owner ruling OR-S4-MEM-RECALL): with `false`, a recalled summary is placed
 *   only in a prompt whose every possible destination is a local provider (`isLocal`, I34); with `true` it may
 *   also go to a remote model. Read from the config on every turn; no other code sets it.
 *
 * A malformed or out-of-range value is a section fallback to the default (never clamped), recorded
 * through `sectionFallbackSink` so `nimbus config explain` names it.
 */
export type NimbusMemoryToml = {
  readonly episodic: boolean;
  readonly retentionDays: number;
  readonly recallRemote: boolean;
};

export const MEMORY_RETENTION_MIN = 7;
export const MEMORY_RETENTION_MAX = 365;

export const DEFAULT_MEMORY_CONFIG: NimbusMemoryToml = Object.freeze({
  episodic: false,
  retentionDays: 90,
  recallRemote: false,
});

function retentionOrDefault(raw: string, onFallback: SectionFallbackSink | undefined): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= MEMORY_RETENTION_MIN && n <= MEMORY_RETENTION_MAX) return n;
  onFallback?.(
    `[memory].retention_days must be an integer ${String(MEMORY_RETENTION_MIN)}..${String(MEMORY_RETENTION_MAX)} (got: ${raw}); using ${String(DEFAULT_MEMORY_CONFIG.retentionDays)}`,
  );
  return DEFAULT_MEMORY_CONFIG.retentionDays;
}

/** A `true`/`false` key of `[memory]`; anything else is a fallback to `false`, recorded. */
function boolOrFalse(
  key: string,
  raw: string,
  onFallback: SectionFallbackSink | undefined,
): boolean {
  const b = parseBool(raw);
  if (b !== undefined) return b;
  onFallback?.(`[memory].${key} must be true or false (got: ${raw}); using false`);
  return false;
}

export function parseNimbusTomlMemory(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusMemoryToml {
  let inSection = false;
  let episodic = DEFAULT_MEMORY_CONFIG.episodic;
  let retentionDays = DEFAULT_MEMORY_CONFIG.retentionDays;
  let recallRemote = DEFAULT_MEMORY_CONFIG.recallRemote;
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
      episodic = boolOrFalse(kv.key, kv.valRaw, onFallback);
    } else if (kv.key === "recall_remote") {
      recallRemote = boolOrFalse(kv.key, kv.valRaw, onFallback);
    } else if (kv.key === "retention_days") {
      retentionDays = retentionOrDefault(kv.valRaw, onFallback);
    }
  }
  return Object.freeze({ episodic, retentionDays, recallRemote });
}

/** `[memory]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusMemoryFromConfigDir(configDir: string): NimbusMemoryToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_MEMORY_CONFIG;
  return parseNimbusTomlMemory(raw, sectionFallbackSink(configDir, "memory"));
}
