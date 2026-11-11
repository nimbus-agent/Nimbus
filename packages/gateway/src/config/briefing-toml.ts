import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseIntDec, splitKeyValue, stripComment } from "./toml-primitives.ts";

/**
 * `[briefing]` - the morning briefing (Phase 10, spec 2026-11-11-morning-briefing.md). MB1 reads ONE key:
 * `snapshot_interval_minutes`, how often a syncable may refresh its "my open work" snapshot (Jira,
 * Linear, GitHub). MB5 adds the other keys to this same file and type.
 *
 * A value out of range or not an integer is a section fallback to the default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped.
 */
export type NimbusBriefingToml = {
  readonly snapshotIntervalMinutes: number;
};

export const BRIEFING_SNAPSHOT_INTERVAL_MIN = 5;
export const BRIEFING_SNAPSHOT_INTERVAL_MAX = 240;

export const DEFAULT_BRIEFING_CONFIG: NimbusBriefingToml = Object.freeze({
  snapshotIntervalMinutes: 15,
});

/** Parse `[briefing]`. A bad value reports through `onFallback` and leaves the default in effect. */
export function parseNimbusTomlBriefing(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusBriefingToml {
  let snapshotIntervalMinutes = DEFAULT_BRIEFING_CONFIG.snapshotIntervalMinutes;
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[briefing]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv?.key !== "snapshot_interval_minutes") continue;
    const n = parseIntDec(kv.valRaw);
    if (
      n !== undefined &&
      n >= BRIEFING_SNAPSHOT_INTERVAL_MIN &&
      n <= BRIEFING_SNAPSHOT_INTERVAL_MAX
    ) {
      snapshotIntervalMinutes = n;
    } else {
      snapshotIntervalMinutes = DEFAULT_BRIEFING_CONFIG.snapshotIntervalMinutes;
      onFallback?.(
        `[briefing].snapshot_interval_minutes must be an integer ${String(BRIEFING_SNAPSHOT_INTERVAL_MIN)}..${String(BRIEFING_SNAPSHOT_INTERVAL_MAX)} (got: ${kv.valRaw}); using ${String(DEFAULT_BRIEFING_CONFIG.snapshotIntervalMinutes)}`,
      );
    }
  }
  return Object.freeze({ snapshotIntervalMinutes });
}

/** `[briefing]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusBriefingFromConfigDir(configDir: string): NimbusBriefingToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_BRIEFING_CONFIG;
  return parseNimbusTomlBriefing(raw, sectionFallbackSink(configDir, "briefing"));
}
