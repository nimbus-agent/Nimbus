import { parseIntDec } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

export type SynthesisMode = "off" | "local" | "allow-remote";

export type NimbusAgentsToml = {
  /**
   * Default "local", NOT "allow-remote". "allow-remote" is the first path by which indexed
   * content can leave the machine without a connector being involved, so it is opt-in.
   */
  synthesis: SynthesisMode;
  /**
   * Deliberately generous. Briefs are fire-and-forget (emit-brief.ts:54 returns
   * before the work), so this does not gate a caller — it exists so a hung
   * provider yields a deterministic brief rather than a briefReady that never
   * arrives. A 3-5s value would reject every synthesis on a cold Ollama.
   */
  synthesisTimeoutMs: number;
};

export const DEFAULT_NIMBUS_AGENTS_TOML: NimbusAgentsToml = {
  synthesis: "local",
  synthesisTimeoutMs: 20000,
};

const SYNTHESIS_MODES: ReadonlySet<string> = new Set(["off", "local", "allow-remote"]);

function applyNimbusAgentsKey(out: NimbusAgentsToml, key: string, valRaw: string): void {
  if (key === "synthesis") {
    const v = valRaw.trim().replace(/^"|"$/g, "");
    // Unknown values fall back to the default. Never widen to "allow-remote" on a typo.
    if (SYNTHESIS_MODES.has(v)) out.synthesis = v as SynthesisMode;
    return;
  }
  if (key === "synthesis_timeout_ms") {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) out.synthesisTimeoutMs = n;
  }
}

export function parseNimbusAgentsToml(
  raw: string,
  defaults: NimbusAgentsToml = DEFAULT_NIMBUS_AGENTS_TOML,
): NimbusAgentsToml {
  const out: NimbusAgentsToml = { ...defaults };
  forEachSectionEntry(raw, "[agents]", (key, valRaw) => applyNimbusAgentsKey(out, key, valRaw));
  return out;
}

// ---------------------------------------------------------------------------
// [persona] — agent persona (Spine S1, W6-A2)
//
// Two knobs only. `tool_caution` and `confidence_threshold` from the original
// roadmap row are REJECTED, not deferred: Non-Negotiable #2 + I2 forbid a knob
// that loosens HITL, and a dial that makes the agent hedge less is the same
// mistake one layer up. See the design spec, D1.
// ---------------------------------------------------------------------------

export type PersonaTone = "neutral" | "terse" | "formal" | "casual" | "verbose";
export type PersonaVoice = "neutral" | "opinionated" | "collective";

export type NimbusPersonaToml = {
  tone: PersonaTone;
  voice: PersonaVoice;
};

/** Both `"neutral"` — the value that makes `applyPersona` the identity function. */
export const DEFAULT_NIMBUS_PERSONA_TOML: NimbusPersonaToml = {
  tone: "neutral",
  voice: "neutral",
};

/** An unrecognised `[persona]` value, surfaced so the loader can warn (design § 5.1). */
export type PersonaIssue = { key: string; value: string };

const PERSONA_TONES: ReadonlySet<string> = new Set([
  "neutral",
  "terse",
  "formal",
  "casual",
  "verbose",
]);
const PERSONA_VOICES: ReadonlySet<string> = new Set(["neutral", "opinionated", "collective"]);

function applyNimbusPersonaKey(
  out: NimbusPersonaToml,
  key: string,
  valRaw: string,
  issues: PersonaIssue[] | undefined,
): void {
  const v = valRaw.trim().replace(/^"|"$/g, "");
  if (key === "tone") {
    if (PERSONA_TONES.has(v)) out.tone = v as PersonaTone;
    else issues?.push({ key, value: v });
    return;
  }
  if (key === "voice") {
    if (PERSONA_VOICES.has(v)) out.voice = v as PersonaVoice;
    else issues?.push({ key, value: v });
  }
}

export function parseNimbusPersonaToml(
  raw: string,
  defaults: NimbusPersonaToml = DEFAULT_NIMBUS_PERSONA_TOML,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  const out: NimbusPersonaToml = { ...defaults };
  forEachSectionEntry(raw, "[persona]", (key, valRaw) =>
    applyNimbusPersonaKey(out, key, valRaw, issues),
  );
  return out;
}

export function loadNimbusPersonaFromPath(
  tomlPath: string,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_PERSONA_TOML, (raw) =>
    parseNimbusPersonaToml(raw, DEFAULT_NIMBUS_PERSONA_TOML, issues),
  );
}

export function loadNimbusPersonaFromConfigDir(
  configDir: string,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  return loadTomlSectionFromConfig(configDir, "persona", DEFAULT_NIMBUS_PERSONA_TOML, (raw) =>
    parseNimbusPersonaToml(raw, DEFAULT_NIMBUS_PERSONA_TOML, issues),
  );
}

/** Single-file `[agents]` reader; `loadNimbusAgentsFromConfigDir` is the layered one. */
export function loadNimbusAgentsFromPath(tomlPath: string): NimbusAgentsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusAgentsToml);
}

/**
 * `[agents]` over the layered snapshot (packs, base, active profile). An earlier config-dir
 * variant read `nimbus.toml` alone and was deleted for being profile-blind — it silently dropped
 * `[agents] synthesis` set in a profile TOML. Reading the layered snapshot closes that.
 */
export function loadNimbusAgentsFromConfigDir(configDir: string): NimbusAgentsToml {
  return loadTomlSectionFromConfig(
    configDir,
    "agents",
    DEFAULT_NIMBUS_AGENTS_TOML,
    parseNimbusAgentsToml,
  );
}

// ---------------------------------------------------------------------------
