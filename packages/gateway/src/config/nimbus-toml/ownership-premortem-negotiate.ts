import { parseIntDec, parseStringArray } from "../toml-primitives.ts";
import {
  applyEnabledToggle,
  applyPassSectionToggle,
  forEachSectionEntry,
  loadTomlSection,
  loadTomlSectionFromConfig,
  parseIntWithMin,
} from "./shared.ts";

export type NimbusOwnershipToml = {
  /** Default ON, like [glossary] and [decisions]. This pass opens nothing and
   * calls no model — it reads local rows and writes local graph edges. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** Recency half-life for blame-line weighting. */
  halfLifeDays: number;
  /** Minimum share for an edge to be emitted. FLOAT — see the parser. */
  minShare: number;
  /** Cap on emitted owners per path; the true count lands on entity metadata. */
  maxOwnersPerPath: number;
  /** Root-relative globs excluded from aggregation. `[]` disables filtering. */
  ignoreGlobs: string[];
};

/**
 * Lock files and generated output are fully present in `git_blame_line`:
 * `gitBlameWindowFiles` (`connectors/blame-index-sync.ts:70`) is a bare
 * `git log --name-only` and consults NO exclude list. Left unfiltered, a
 * churning lock file is thousands of lines credited to whoever last ran the
 * installer, and would dominate its directory's rollup.
 */
const DEFAULT_OWNERSHIP_IGNORE_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/vendor/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
];

export const DEFAULT_NIMBUS_OWNERSHIP_TOML: NimbusOwnershipToml = {
  enabled: true,
  debounceMs: 30_000,
  halfLifeDays: 365,
  minShare: 0.05,
  maxOwnersPerPath: 10,
  ignoreGlobs: [...DEFAULT_OWNERSHIP_IGNORE_GLOBS],
};

function applyNimbusOwnershipKey(
  out: Partial<NimbusOwnershipToml>,
  key: string,
  valRaw: string,
): void {
  // `applyEnabledToggle`, NOT `applyPassSectionToggle`: `[ownership]` has no `use_llm` key, and
  // the two-key helper would write one onto the returned config.
  if (applyEnabledToggle(out, key, valRaw)) return;
  if (key === "ignore_globs") {
    // `parseStringArray` THROWS a TypeError on anything not bracket-delimited.
    // Unguarded, that escapes `parseNimbusOwnershipToml` into `loadTomlSection`'s
    // catch, which discards the WHOLE `[ownership]` section — so one malformed
    // glob line would silently re-enable a pass the user had turned off with
    // `enabled = false`. Swallow it here instead: `ignoreGlobs` stays unset and
    // falls back to the default list, every other key in the section survives.
    try {
      // An explicit empty array is meaningful (disable filtering), so this must
      // NOT be guarded on length.
      out.ignoreGlobs = parseStringArray(valRaw);
    } catch {
      /* malformed: keep the default ignore list */
    }
    return;
  }
  // `min_share` is the one FLOAT key, so it MUST precede the integer branch:
  // that branch would truncate 0.05 to 0, and its `n <= 0` guard would then
  // discard it before the clamp ever ran — silently disabling the threshold.
  // Identical to the [decisions].min_confidence trap at lines 1663-1665.
  if (key === "min_share") {
    const f = Number(valRaw.trim());
    if (valRaw.trim() !== "" && Number.isFinite(f)) {
      out.minShare = Math.min(1, Math.max(0, f));
    }
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "half_life_days":
      out.halfLifeDays = n;
      break;
    case "max_owners_per_path":
      out.maxOwnersPerPath = n;
      break;
    default:
      break;
  }
}

export function parseNimbusOwnershipToml(
  raw: string,
  defaults: NimbusOwnershipToml = DEFAULT_NIMBUS_OWNERSHIP_TOML,
): NimbusOwnershipToml {
  const out: Partial<NimbusOwnershipToml> = {};
  forEachSectionEntry(raw, "[ownership]", (key, valRaw) =>
    applyNimbusOwnershipKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusOwnershipFromConfigDir(configDir: string): NimbusOwnershipToml {
  return loadTomlSectionFromConfig(
    configDir,
    "ownership",
    DEFAULT_NIMBUS_OWNERSHIP_TOML,
    parseNimbusOwnershipToml,
  );
}

// ---------------------------------------------------------------------------
// [premortem] — recurring blocker theme extraction pass (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusPremortemToml = {
  /** Default ON, like [glossary]/[decisions]/[ownership]. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** When false the pass runs but writes zero themes; structural risks are unaffected. */
  useLlm: boolean;
  /** Hard ceiling on model calls per pass. */
  maxLlmCallsPerPass: number;
  /** Cap on the cohort PR B assembles. */
  maxCohortSize: number;
  /** Cap on closed epics scanned for a service set before the cohort lane stops. */
  maxCandidateScan: number;
};

export const DEFAULT_NIMBUS_PREMORTEM_TOML: NimbusPremortemToml = {
  enabled: true,
  debounceMs: 60_000,
  useLlm: true,
  maxLlmCallsPerPass: 25,
  maxCohortSize: 10,
  maxCandidateScan: 200,
};

/**
 * A malformed or non-positive bound falls back to its default rather than
 * clamping to zero: `max_candidate_scan = 0` would yield an empty cohort that
 * reads as "no comparable epics ever closed", which is a wrong answer rather
 * than an empty one.
 */
function applyNimbusPremortemKey(
  out: Partial<NimbusPremortemToml>,
  key: string,
  valRaw: string,
): void {
  // Bool keys MUST come before the integer branch below — same regression the
  // [glossary] block guards against: routed through `parseIntDec`, `use_llm`
  // is silently dropped and the section reads as if it were never set.
  if (applyPassSectionToggle(out, key, valRaw)) return;
  const n = parseIntWithMin(valRaw, 1);
  if (n === undefined) return;
  switch (key) {
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "max_llm_calls_per_pass":
      out.maxLlmCallsPerPass = n;
      break;
    case "max_cohort_size":
      out.maxCohortSize = n;
      break;
    case "max_candidate_scan":
      out.maxCandidateScan = n;
      break;
    default:
      break;
  }
}

export function parseNimbusPremortemToml(
  raw: string,
  defaults: NimbusPremortemToml = DEFAULT_NIMBUS_PREMORTEM_TOML,
): NimbusPremortemToml {
  const out: Partial<NimbusPremortemToml> = {};
  forEachSectionEntry(raw, "[premortem]", (key, valRaw) =>
    applyNimbusPremortemKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusPremortemFromConfigDir(configDir: string): NimbusPremortemToml {
  return loadTomlSectionFromConfig(
    configDir,
    "premortem",
    DEFAULT_NIMBUS_PREMORTEM_TOML,
    parseNimbusPremortemToml,
  );
}

// ---------------------------------------------------------------------------
// [negotiate] — personal-docs opt-in for the contribution-brief agent (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusNegotiateToml = {
  /**
   * Personal sources (e.g. `obsidian`) are mined by `nimbus negotiate` only when named
   * here — configuration IS the consent (spec § 3.3, following the `[glossary.terms]`
   * precedent). Empty means work artifacts only.
   */
  personalSources: string[];
};

export const DEFAULT_NIMBUS_NEGOTIATE_TOML: NimbusNegotiateToml = { personalSources: [] };

/**
 * `parseStringArray` cannot distinguish a quoted TOML string from a bare token: an
 * unquoted `42` parses through as the literal string "42", with no quoting information
 * left to recover afterward. Such a bare numeric entry was never actually authored as a
 * string, so it is dropped here rather than reaching a query — fail-safe toward excluding
 * (Task 6 brief's two malformed-input rules).
 */
function isBareNumericToken(entry: string): boolean {
  const t = entry.trim();
  return t !== "" && Number.isFinite(Number(t));
}

/**
 * Blank and non-string (bare numeric) entries are dropped at parse time, never reaching
 * a query. A malformed (non-array) value falls back to an empty list rather than throwing.
 *
 * Entries are lower-cased because the consumer matches them against `item.service`, which is
 * always a lower-case connector id: `personal_sources = ["Obsidian"]` is a natural thing to
 * write in TOML, and matched nothing under an exact, case-sensitive comparison — an UNDERCOUNT
 * that `nimbus negotiate` then reported as configured coverage. Folding here rather than at the
 * comparison site keeps one normalisation point for every future consumer of the list.
 */
function parsePersonalSources(valRaw: string): string[] {
  try {
    return parseStringArray(valRaw)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && !isBareNumericToken(s));
  } catch {
    return [];
  }
}

function parseNimbusTomlNegotiateSection(source: string): Partial<NimbusNegotiateToml> {
  const out: Partial<NimbusNegotiateToml> = {};
  forEachSectionEntry(source, "[negotiate]", (key, valRaw) => {
    if (key === "personal_sources") {
      out.personalSources = parsePersonalSources(valRaw);
    }
  });
  return out;
}

export function parseNimbusNegotiateToml(
  raw: string,
  defaults: NimbusNegotiateToml = DEFAULT_NIMBUS_NEGOTIATE_TOML,
): NimbusNegotiateToml {
  return { ...defaults, ...parseNimbusTomlNegotiateSection(raw) };
}

export function loadNimbusNegotiateFromPath(tomlPath: string): NimbusNegotiateToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_NEGOTIATE_TOML, parseNimbusNegotiateToml);
}

export function loadNimbusNegotiateFromConfigDir(configDir: string): NimbusNegotiateToml {
  return loadTomlSectionFromConfig(
    configDir,
    "negotiate",
    DEFAULT_NIMBUS_NEGOTIATE_TOML,
    parseNimbusNegotiateToml,
  );
}

// ---------------------------------------------------------------------------
// [agents] — built-in agent brief synthesis (Spine S1, W6-A0)
// ---------------------------------------------------------------------------
