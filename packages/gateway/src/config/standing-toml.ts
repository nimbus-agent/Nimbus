import { existsSync, readFileSync } from "node:fs";
import {
  fallbackMessage,
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { isTableHeader, parseIntDec, splitKeyValue, stripComment } from "./toml-primitives.ts";

/**
 * `[standing]` — approval learning (Phase 10 SA5, spec § 6.4). `suggest_after` is how many runs in a
 * row the owner must approve a write step by hand before Nimbus records a suggestion; `0` turns
 * learning off. A suggestion never creates, widens or approves anything.
 */
export type NimbusStandingToml = {
  readonly suggestAfter: number;
};

export const DEFAULT_STANDING_CONFIG: NimbusStandingToml = Object.freeze({ suggestAfter: 5 });

export const STANDING_SUGGEST_AFTER_MIN = 3;
export const STANDING_SUGGEST_AFTER_MAX = 50;

export class StandingConfigError extends Error {}

export type StandingConfigLoad =
  | { readonly ok: true; readonly config: NimbusStandingToml }
  | { readonly ok: false; readonly error: string };

function parseSuggestAfter(valRaw: string): number {
  const n = parseIntDec(valRaw);
  const inRange =
    n !== undefined && n >= STANDING_SUGGEST_AFTER_MIN && n <= STANDING_SUGGEST_AFTER_MAX;
  if (n === undefined || (n !== 0 && !inRange)) {
    throw new StandingConfigError(
      `[standing].suggest_after must be 0 (off) or an integer ${String(STANDING_SUGGEST_AFTER_MIN)}..${String(STANDING_SUGGEST_AFTER_MAX)} (got: ${valRaw})`,
    );
  }
  return n;
}

/** Parse `[standing]`. Throws `StandingConfigError` on a value out of range, never clamps. */
export function parseNimbusTomlStanding(source: string): NimbusStandingToml {
  let suggestAfter = DEFAULT_STANDING_CONFIG.suggestAfter;
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[standing]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv?.key === "suggest_after") suggestAfter = parseSuggestAfter(kv.valRaw);
  }
  return Object.freeze({ suggestAfter });
}

/** The one `[standing]` core. `raw === null` means no file (parsed as empty). */
function loadStandingFromText(
  raw: string | null,
  onFallback?: SectionFallbackSink,
): StandingConfigLoad {
  try {
    return { ok: true, config: parseNimbusTomlStanding(raw ?? "") };
  } catch (e) {
    onFallback?.(fallbackMessage(e));
    if (e instanceof StandingConfigError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Load from one file. A bad file is a VALUE (`ok: false`). */
export function loadNimbusStandingFromPath(tomlPath: string): StandingConfigLoad {
  return loadStandingFromText(existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null);
}

/** `[standing]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusStandingFromConfigDir(configDir: string): StandingConfigLoad {
  return loadStandingFromText(
    layeredConfigText(configDir),
    sectionFallbackSink(configDir, "standing"),
  );
}
