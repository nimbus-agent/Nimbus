/**
 * Personalization (Phase 10, owner ruling OR-S4-PERS): the owner's EXPLICIT `[personalization]`
 * preferences applied to one turn. Pure, no I/O, and it imports no write table and builds no tool.
 *
 * THE TOOL RULE (I53 amended). `applyToolPreferences` runs on the FINAL tool map of a turn, after
 * every offer path (the base tools, I35 computer-use, I60 generated tools, I42 user MCP and the
 * I53 connector-write door) has decided what is offered. It can only
 *   - REMOVE the tools the owner hid, and
 *   - move the tools the owner ordered to the front,
 * so the result is always a subset of its input: it never adds a tool, never re-offers one an
 * earlier check refused, and a tool absent from the input stays absent whatever the preferences
 * say. Hiding wins over ordering. Every per-call check (the executor gate, the owner's prompt)
 * is unchanged: a hidden tool is simply not in the list the model sees.
 *
 * THE STYLE RULE. Tone and verbosity are enumerated values; the text the model reads is written
 * HERE, never copied from the config. Like every persona directive (`engine/persona.ts`, D6) they
 * govern how an answer is worded, never whether content appears.
 */

import pino from "pino";
import { type NimbusPersonaToml, resolvePersona } from "../config/persona.ts";
import {
  loadNimbusPersonalizationFromConfigDir,
  type NimbusPersonalizationToml,
  type PersonalizationVerbosity,
} from "../config/personalization-toml.ts";

export const VERBOSITY_DIRECTIVES: Readonly<Record<PersonalizationVerbosity, string>> = {
  default: "",
  brief:
    "Keep the answer compact: lead with the answer, then the supporting detail in as few words as the facts allow.",
  detailed:
    "Give a fuller answer: include the supporting detail and the reasoning behind each conclusion.",
};

/** The verbosity sentence, or `""` for the default (the prompt then does not move). */
export function verbosityDirective(prefs: NimbusPersonalizationToml | undefined): string {
  return prefs === undefined ? "" : VERBOSITY_DIRECTIVES[prefs.verbosity];
}

/**
 * The persona an ask turn uses: `[persona]`, with `[personalization] tone` taking over the tone
 * when the owner set one (a neutral personalization tone leaves `[persona]` alone).
 */
export function mergePersonaTone(
  persona: NimbusPersonaToml,
  prefs: NimbusPersonalizationToml,
): NimbusPersonaToml {
  return prefs.tone === "neutral" ? persona : { ...persona, tone: prefs.tone };
}

/** What `runAsk` hands the turn: the persona and the verbosity sentence, read per invocation. */
export function resolveAskStyle(configDir: string): {
  persona: NimbusPersonaToml;
  verbosity: string;
} {
  const prefs = loadNimbusPersonalizationFromConfigDir(configDir);
  return {
    persona: mergePersonaTone(resolvePersona(configDir), prefs),
    verbosity: verbosityDirective(prefs),
  };
}

export type ToolPreferenceWarn = (name: string, message: string) => void;

const warnedNames = new Set<string>();

/** Test-only: reset the warn-once memo. */
export function resetToolPreferenceWarningsForTest(): void {
  warnedNames.clear();
}

/**
 * Hide, then order. `complete` is true only on a turn whose every offer path was open (the local
 * owner's turn), so a name that matches nothing there is reported once as having no effect (a
 * warning, never an error: the tool may be off, not enabled, or not exist).
 */
export function applyToolPreferences<T extends Record<string, unknown>>(
  tools: T,
  prefs: NimbusPersonalizationToml | undefined,
  options: { readonly complete?: boolean; readonly warn?: ToolPreferenceWarn } = {},
): T {
  if (prefs === undefined || (prefs.hideTools.length === 0 && prefs.toolOrder.length === 0)) {
    return tools;
  }
  if (options.complete === true && options.warn !== undefined) {
    for (const name of [...prefs.hideTools, ...prefs.toolOrder]) {
      if (Object.hasOwn(tools, name) || warnedNames.has(name)) continue;
      warnedNames.add(name);
      options.warn(name, `[personalization] names "${name}", which is not offered to the model`);
    }
  }
  const hidden = new Set(prefs.hideTools);
  const names = Object.keys(tools).filter((n) => !hidden.has(n));
  const first = prefs.toolOrder.filter((n) => names.includes(n));
  const rest = names.filter((n) => !first.includes(n));
  const out: Record<string, unknown> = {};
  for (const n of [...first, ...rest]) out[n] = tools[n];
  return out as T;
}

/**
 * The agent's `personalization` dependency: `[personalization]` read through the layered reader on
 * EVERY request (an edit applies on the next turn, no restart), a warning once per ignored value.
 */
export function personalizationDeps(
  configDir: string,
  logger: { warn: (obj: unknown, msg: string) => void } = pino({ name: "personalization" }),
): {
  get: () => NimbusPersonalizationToml;
  warn: ToolPreferenceWarn;
} {
  const seen = new Set<string>();
  return {
    get: () => {
      const prefs = loadNimbusPersonalizationFromConfigDir(configDir);
      for (const w of prefs.warnings) {
        if (seen.has(w)) continue;
        seen.add(w);
        logger.warn({ section: "personalization" }, w);
      }
      return prefs;
    },
    warn: (name, message) => logger.warn({ tool: name }, message),
  };
}
