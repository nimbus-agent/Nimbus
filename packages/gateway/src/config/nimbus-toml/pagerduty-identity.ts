import { existsSync, readFileSync } from "node:fs";
import {
  fallbackMessage,
  layeredConfigText,
  layerReadError,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "../layered-config.ts";
import { parseBool, parseIntDec, parseString, parseStringArray } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSectionFromConfig } from "./shared.ts";

export type NimbusPagerdutyToml = {
  maxPagesPerSync: number;
  severityP1Aliases: readonly string[];
};

export const DEFAULT_NIMBUS_PAGERDUTY_TOML: NimbusPagerdutyToml = {
  maxPagesPerSync: 20,
  severityP1Aliases: [],
};

function parseMaxPagesPerSync(valRaw: string): number {
  const n = parseIntDec(valRaw);
  if (n === undefined || n < 1 || n > 100) {
    throw new Error(`[pagerduty].max_pages_per_sync must be an integer in 1..100, got '${valRaw}'`);
  }
  return n;
}

function parseSeverityP1Aliases(valRaw: string): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  for (const v of parseStringArray(valRaw)) {
    const lower = v.trim().toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    collected.push(lower);
  }
  return collected;
}

function parseNimbusPagerdutySection(source: string): Partial<NimbusPagerdutyToml> {
  const out: { maxPagesPerSync?: number; severityP1Aliases?: readonly string[] } = {};
  forEachSectionEntry(source, "[pagerduty]", (key, valRaw) => {
    if (key === "max_pages_per_sync") {
      out.maxPagesPerSync = parseMaxPagesPerSync(valRaw);
    } else if (key === "severity_p1_aliases") {
      out.severityP1Aliases = parseSeverityP1Aliases(valRaw);
    }
  });
  return out;
}

export function parseNimbusPagerdutyToml(
  raw: string,
  defaults: NimbusPagerdutyToml = DEFAULT_NIMBUS_PAGERDUTY_TOML,
): NimbusPagerdutyToml {
  return { ...defaults, ...parseNimbusPagerdutySection(raw) };
}

export function loadNimbusPagerdutyFromPath(tomlPath: string): NimbusPagerdutyToml {
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `nimbus: could not read [pagerduty] config at ${tomlPath}, using defaults: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  return loadNimbusPagerdutyFromText(raw, tomlPath);
}

/**
 * The one `[pagerduty]` core. `text === null` means no file; a rejected section warns on stderr
 * (naming `where`) and falls back to the defaults.
 */
function loadNimbusPagerdutyFromText(
  text: string | null,
  where: string,
  onFallback?: SectionFallbackSink,
): NimbusPagerdutyToml {
  if (text === null) {
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  try {
    return parseNimbusPagerdutyToml(text);
  } catch (err) {
    onFallback?.(fallbackMessage(err));
    process.stderr.write(
      `nimbus: [pagerduty] config in ${where} rejected, using defaults: ${fallbackMessage(err)}\n`,
    );
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
}

export function loadNimbusPagerdutyFromConfigDir(configDir: string): NimbusPagerdutyToml {
  const readError = layerReadError(configDir);
  if (readError !== undefined) {
    sectionFallbackSink(configDir, "pagerduty")(readError);
    process.stderr.write(`nimbus: [pagerduty] ${readError}, using defaults\n`);
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  return loadNimbusPagerdutyFromText(
    layeredConfigText(configDir),
    `the layered config for ${configDir}`,
    sectionFallbackSink(configDir, "pagerduty"),
  );
}

export type NimbusIdentityToml = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  flow: "device_code";
  scopes: string[];
  sessionGraceSeconds: number;
  revalidateIntervalSeconds: number;
  tokenRefreshSkewSeconds: number;
  jwksMaxAgeSeconds: number;
};

export const DEFAULT_NIMBUS_IDENTITY_TOML: NimbusIdentityToml = {
  enabled: false,
  issuer: "",
  clientId: "",
  flow: "device_code",
  scopes: ["openid", "email", "profile"],
  sessionGraceSeconds: 86400,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};

/** Maps a `[identity]` numeric key to its target field + minimum-accepted value. */
const NIMBUS_IDENTITY_NUMERIC_KEYS: Readonly<
  Record<string, { field: keyof NimbusIdentityToml; min: number }>
> = {
  session_grace_seconds: { field: "sessionGraceSeconds", min: 0 },
  revalidate_interval_seconds: { field: "revalidateIntervalSeconds", min: 1 },
  token_refresh_skew_seconds: { field: "tokenRefreshSkewSeconds", min: 0 },
  jwks_max_age_seconds: { field: "jwksMaxAgeSeconds", min: 1 },
};

/** Applies a numeric `[identity]` key. Returns true if `key` was a recognized numeric key. */
function applyNimbusIdentityNumericKey(
  out: Partial<NimbusIdentityToml>,
  key: string,
  valRaw: string,
): boolean {
  const spec = NIMBUS_IDENTITY_NUMERIC_KEYS[key];
  if (spec === undefined) return false;
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= spec.min) {
    (out[spec.field] as number) = n;
  }
  return true;
}

function applyNimbusIdentityKey(
  out: Partial<NimbusIdentityToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "issuer":
      out.issuer = parseString(valRaw);
      break;
    case "client_id":
      out.clientId = parseString(valRaw);
      break;
    case "scopes": {
      const arr = parseStringArray(valRaw).filter((s) => s.length > 0);
      if (arr.length > 0) out.scopes = arr;
      break;
    }
    default:
      applyNimbusIdentityNumericKey(out, key, valRaw);
      break;
  }
}

export function parseNimbusIdentityToml(
  raw: string,
  defaults: NimbusIdentityToml = DEFAULT_NIMBUS_IDENTITY_TOML,
): NimbusIdentityToml {
  const out: Partial<NimbusIdentityToml> = {};
  forEachSectionEntry(raw, "[identity]", (key, valRaw) => applyNimbusIdentityKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusIdentityFromConfigDir(configDir: string): NimbusIdentityToml {
  return loadTomlSectionFromConfig(
    configDir,
    "identity",
    DEFAULT_NIMBUS_IDENTITY_TOML,
    parseNimbusIdentityToml,
  );
}

// ---------------------------------------------------------------------------
// [hitl.quorum] — per-action-type quorum rules
// ---------------------------------------------------------------------------
