import { parseBool, parseIntDec } from "../toml-primitives.ts";
import {
  applyPassSectionToggle,
  forEachSectionEntry,
  loadTomlSection,
  loadTomlSectionFromConfig,
} from "./shared.ts";

export type NimbusBriefsToml = {
  /** Default OFF: briefs are the first surface that can send user content to a remote model. */
  enabled: boolean;
  /** Route synthesis to a local provider when one is available. */
  preferLocal: boolean;
  ttlMinutes: number;
};

export const DEFAULT_NIMBUS_BRIEFS_TOML: NimbusBriefsToml = {
  enabled: false,
  preferLocal: true,
  ttlMinutes: 30,
};

function applyNimbusBriefsKey(out: Partial<NimbusBriefsToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "prefer_local": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.preferLocal = b;
      break;
    }
    case "ttl_minutes": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.ttlMinutes = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusBriefsToml(
  raw: string,
  defaults: NimbusBriefsToml = DEFAULT_NIMBUS_BRIEFS_TOML,
): NimbusBriefsToml {
  const out: Partial<NimbusBriefsToml> = {};
  forEachSectionEntry(raw, "[briefs]", (key, valRaw) => applyNimbusBriefsKey(out, key, valRaw));
  return { ...defaults, ...out };
}

// The assemble consumer reads from a path — mirror the existing loadNimbus<X>FromPath
// helpers (there is NO `readActiveTomlRaw`; `loadTomlSection` is the real primitive and
// already handles a missing file / parse error by returning the defaults).
export function loadNimbusBriefsFromPath(tomlPath: string): NimbusBriefsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_BRIEFS_TOML, (raw) => parseNimbusBriefsToml(raw));
}

export function loadNimbusBriefsFromConfigDir(configDir: string): NimbusBriefsToml {
  return loadTomlSectionFromConfig(configDir, "briefs", DEFAULT_NIMBUS_BRIEFS_TOML, (raw) =>
    parseNimbusBriefsToml(raw),
  );
}

// ---------------------------------------------------------------------------
// [glossary] — implicit-knowledge glossary (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusGlossaryToml = {
  /**
   * Default ON, unlike [briefs]. Briefs open an HTTP write surface; the
   * glossary opens nothing — it reads the local index and writes local rows.
   */
  enabled: boolean;
  /**
   * Consolidate via a LOCAL model. Default on, but separable from `enabled`:
   * turning this off keeps the cheap snippet glossary while sparing a laptop
   * up to `max_new_terms_per_pass` sequential local-model calls per sync burst.
   */
  useLlm: boolean;
  /** LLM calls per pass (sequential). */
  maxNewTermsPerPass: number;
  /** Reconciliation sweep width — pure SQL, no LLM cost. */
  statsRecheckPerPass: number;
  /** Skip re-verifying a term checked more recently than this (default 12 h). */
  statsRecheckCooldownMs: number;
  minDocFreq: number;
  debounceMs: number;
  consolidateTimeoutMs: number;
  /** Base for the exponential retry backoff that prevents queue starvation. */
  retryBaseCooldownMs: number;
};

export const DEFAULT_NIMBUS_GLOSSARY_TOML: NimbusGlossaryToml = {
  enabled: true,
  useLlm: true,
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 12 * 60 * 60 * 1000,
  minDocFreq: 3,
  debounceMs: 60000,
  consolidateTimeoutMs: 30000,
  retryBaseCooldownMs: 15 * 60 * 1000,
};

function applyNimbusGlossaryKey(
  out: Partial<NimbusGlossaryToml>,
  key: string,
  valRaw: string,
): void {
  if (applyPassSectionToggle(out, key, valRaw)) return;
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "max_new_terms_per_pass":
      out.maxNewTermsPerPass = n;
      break;
    case "stats_recheck_per_pass":
      out.statsRecheckPerPass = n;
      break;
    case "stats_recheck_cooldown_ms":
      out.statsRecheckCooldownMs = n;
      break;
    case "retry_base_cooldown_ms":
      out.retryBaseCooldownMs = n;
      break;
    case "min_doc_freq":
      out.minDocFreq = n;
      break;
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "consolidate_timeout_ms":
      out.consolidateTimeoutMs = n;
      break;
    default:
      break;
  }
}

export function parseNimbusGlossaryToml(
  raw: string,
  defaults: NimbusGlossaryToml = DEFAULT_NIMBUS_GLOSSARY_TOML,
): NimbusGlossaryToml {
  const out: Partial<NimbusGlossaryToml> = {};
  forEachSectionEntry(raw, "[glossary]", (key, valRaw) => applyNimbusGlossaryKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusGlossaryFromConfigDir(configDir: string): NimbusGlossaryToml {
  return loadTomlSectionFromConfig(
    configDir,
    "glossary",
    DEFAULT_NIMBUS_GLOSSARY_TOML,
    parseNimbusGlossaryToml,
  );
}

// ---------------------------------------------------------------------------
// [decisions] — implicit decision extraction (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusDecisionsToml = {
  /**
   * Default ON, like [glossary] and unlike [briefs]: extraction opens no
   * network surface — it reads the local index and writes local rows.
   */
  enabled: boolean;
  /**
   * Extract via a LOCAL model. Default on, but separable from `enabled`:
   * turning this off keeps the cheap heuristic pass while sparing a laptop up
   * to `max_llm_calls_per_pass` sequential local-model calls per sync burst.
   */
  useLlm: boolean;
  /**
   * READ-path floor: `nimbus decisions` omits any stored decision scoring
   * below this when `--min-confidence` is not given. Clamped into 0..1.
   * Extraction stores everything regardless, so changing this re-filters an
   * existing store rather than needing a `--rebuild`.
   */
  minConfidence: number;
  /** LLM calls per pass (sequential). */
  maxLlmCallsPerPass: number;
  debounceMs: number;
  /** Cooldown before a failed extraction is retried (prevents starvation). */
  retryCooldownMs: number;
};

export const DEFAULT_NIMBUS_DECISIONS_TOML: NimbusDecisionsToml = {
  enabled: true,
  useLlm: true,
  minConfidence: 0.3,
  maxLlmCallsPerPass: 25,
  debounceMs: 30_000,
  retryCooldownMs: 60_000,
};

function applyNimbusDecisionsKey(
  out: Partial<NimbusDecisionsToml>,
  key: string,
  valRaw: string,
): void {
  // Bool keys MUST come before the integer branch below — same regression the
  // [glossary] block guards against: routed through `parseIntDec`, `use_llm`
  // is silently dropped and the section reads as if it were never set.
  if (applyPassSectionToggle(out, key, valRaw)) return;
  // `min_confidence` is the one FLOAT key, so it must precede the integer
  // branch too: that branch would truncate 0.7 to 0, and its `n <= 0` guard
  // would discard a negative before the clamp below ever saw it.
  if (key === "min_confidence") {
    const f = Number(valRaw.trim());
    if (valRaw.trim() !== "" && Number.isFinite(f)) {
      out.minConfidence = Math.min(1, Math.max(0, f));
    }
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "max_llm_calls_per_pass":
      out.maxLlmCallsPerPass = n;
      break;
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "retry_cooldown_ms":
      out.retryCooldownMs = n;
      break;
    default:
      break;
  }
}

export function parseNimbusDecisionsToml(
  raw: string,
  defaults: NimbusDecisionsToml = DEFAULT_NIMBUS_DECISIONS_TOML,
): NimbusDecisionsToml {
  const out: Partial<NimbusDecisionsToml> = {};
  forEachSectionEntry(raw, "[decisions]", (key, valRaw) =>
    applyNimbusDecisionsKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusDecisionsFromConfigDir(configDir: string): NimbusDecisionsToml {
  return loadTomlSectionFromConfig(
    configDir,
    "decisions",
    DEFAULT_NIMBUS_DECISIONS_TOML,
    parseNimbusDecisionsToml,
  );
}

// ---------------------------------------------------------------------------
// [ownership] — ownership graph derivation pass (Spine S1)
// ---------------------------------------------------------------------------
