import { existsSync, readFileSync } from "node:fs";
import { layeredConfigText } from "./layered-config.ts";
import {
  isTableHeader,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[personalization]` (Phase 10, owner ruling OR-S4-PERS, 2026-11-23). EXPLICIT preferences only:
 * nothing here is ever inferred from behaviour. `tone` and `verbosity` are ENUMERATED values the
 * gateway turns into fixed sentences it wrote itself (the config is never a prompt-injection
 * channel); `tool_order` and `hide_tools` name tools by the exact name the model is offered.
 *
 * Hiding only REMOVES a tool from what the I53 / I60 / I35 / I42 offer paths already produced;
 * ordering never changes membership (`engine/personalization.ts`). A bad value is a WARNING and
 * falls back to the default for that key: this section can never fail a load.
 */
export const PERSONALIZATION_TONES = ["neutral", "terse", "formal", "casual", "verbose"] as const;
export type PersonalizationTone = (typeof PERSONALIZATION_TONES)[number];

export const PERSONALIZATION_VERBOSITIES = ["default", "brief", "detailed"] as const;
export type PersonalizationVerbosity = (typeof PERSONALIZATION_VERBOSITIES)[number];

export type NimbusPersonalizationToml = {
  readonly tone: PersonalizationTone;
  readonly verbosity: PersonalizationVerbosity;
  /** Names offered first, in this order, when the turn offers them. */
  readonly toolOrder: readonly string[];
  /** Names never offered to the model. */
  readonly hideTools: readonly string[];
  /** One line per ignored value, for the log and `nimbus config explain`. */
  readonly warnings: readonly string[];
};

export const DEFAULT_PERSONALIZATION: NimbusPersonalizationToml = Object.freeze({
  tone: "neutral",
  verbosity: "default",
  toolOrder: Object.freeze([]) as readonly string[],
  hideTools: Object.freeze([]) as readonly string[],
  warnings: Object.freeze([]) as readonly string[],
});

/** The characters a model-facing tool name may carry (`CONNECTOR_WRITE_TOOL_NAME_MAX` is 64). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const PERSONALIZATION_LIST_MAX = 200;

function oneOf<T extends string>(
  key: string,
  valRaw: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const v = parseString(valRaw).trim();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  warnings.push(`[personalization].${key} = "${v}" is not one of ${allowed.join(", ")}; ignored`);
  return fallback;
}

function toolNames(key: string, valRaw: string, warnings: string[]): string[] {
  let list: string[];
  try {
    list = parseStringArray(valRaw);
  } catch {
    warnings.push(`[personalization].${key} must be an array of strings; ignored`);
    return [];
  }
  const out: string[] = [];
  for (const name of list) {
    if (!TOOL_NAME.test(name)) {
      warnings.push(`[personalization].${key}: "${name.slice(0, 40)}" is not a tool name; ignored`);
    } else if (!out.includes(name)) {
      out.push(name);
    }
  }
  if (out.length > PERSONALIZATION_LIST_MAX) {
    warnings.push(`[personalization].${key} lists more than ${PERSONALIZATION_LIST_MAX}; cut`);
    out.length = PERSONALIZATION_LIST_MAX;
  }
  return out;
}

/** Parse `[personalization]`. Never throws: every problem is a warning and a default. */
export function parseNimbusTomlPersonalization(source: string): NimbusPersonalizationToml {
  const warnings: string[] = [];
  let tone: PersonalizationTone = DEFAULT_PERSONALIZATION.tone;
  let verbosity: PersonalizationVerbosity = DEFAULT_PERSONALIZATION.verbosity;
  let toolOrder: string[] = [];
  let hideTools: string[] = [];
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[personalization]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    if (kv.key === "tone") {
      tone = oneOf("tone", kv.valRaw, PERSONALIZATION_TONES, "neutral", warnings);
    } else if (kv.key === "verbosity") {
      verbosity = oneOf("verbosity", kv.valRaw, PERSONALIZATION_VERBOSITIES, "default", warnings);
    } else if (kv.key === "tool_order") {
      toolOrder = toolNames("tool_order", kv.valRaw, warnings);
    } else if (kv.key === "hide_tools") {
      hideTools = toolNames("hide_tools", kv.valRaw, warnings);
    } else {
      warnings.push(`[personalization].${kv.key} is not a known key; ignored`);
    }
  }
  return Object.freeze({ tone, verbosity, toolOrder, hideTools, warnings });
}

export function loadNimbusPersonalizationFromPath(tomlPath: string): NimbusPersonalizationToml {
  return parseNimbusTomlPersonalization(existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "");
}

/** `[personalization]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusPersonalizationFromConfigDir(
  configDir: string,
): NimbusPersonalizationToml {
  return parseNimbusTomlPersonalization(layeredConfigText(configDir) ?? "");
}

/**
 * The lines `nimbus config explain` shows for the active preferences: for a whole-file explain or
 * a `personalization` path, and nothing otherwise.
 */
export function personalizationExplainNotes(configDir: string, path: string | undefined): string[] {
  if (path !== undefined && path !== "personalization" && !path.startsWith("personalization.")) {
    return [];
  }
  const prefs = loadNimbusPersonalizationFromConfigDir(configDir);
  const list = (names: readonly string[]): string =>
    names.length === 0 ? "(none)" : names.join(", ");
  return [
    `personalization: tone ${prefs.tone}${prefs.tone === "neutral" ? "" : " (replaces [persona] tone)"}, verbosity ${prefs.verbosity}`,
    `personalization: tool order ${list(prefs.toolOrder)}`,
    `personalization: hidden tools ${list(prefs.hideTools)} (hiding only removes a tool; it never adds or widens one)`,
    ...prefs.warnings.map((w) => `personalization: ${w}`),
  ];
}
