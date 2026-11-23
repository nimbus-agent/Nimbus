import { layerReadError } from "../layered-config.ts";
import { parseBool, parseIntDec, parseString, parseStringArray } from "../toml-primitives.ts";
import {
  beginQuotedIdTable,
  collectSubTableKv,
  forEachSectionEntry,
  loadTomlSectionFromConfig,
  parseIntWithMin,
} from "./shared.ts";

export interface PreflightCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

export type PreflightConfig = ReadonlyMap<string, PreflightCommandConfig>;

const PREFLIGHT_TABLE_PREFIX = '[federation.preflight."';
const PREFLIGHT_TIMEOUT_DEFAULT = 300;
const PREFLIGHT_TIMEOUT_CAP = 1800;

/** Accumulates raw kv strings per `[federation.preflight."<namespace>"]` sub-table. */
function collectPreflightKvSections(source: string): Map<string, Record<string, string>> {
  return collectSubTableKv(source, (accum, trimmed) =>
    beginQuotedIdTable(accum, trimmed, PREFLIGHT_TABLE_PREFIX),
  );
}

/**
 * Converts one sub-table's raw kv strings into a PreflightCommandConfig, or undefined when
 * no `command` key is present or it is empty (command-less tables are ignored).
 */
function toPreflightCommandConfig(kv: Record<string, string>): PreflightCommandConfig | undefined {
  const commandRaw = kv["command"];
  if (commandRaw === undefined) return undefined;
  const command = parseString(commandRaw);
  if (command.length === 0) return undefined;
  const timeoutParsed =
    kv["timeout_seconds"] === undefined ? undefined : parseIntDec(kv["timeout_seconds"]);
  const timeoutSeconds =
    timeoutParsed === undefined || timeoutParsed <= 0
      ? PREFLIGHT_TIMEOUT_DEFAULT
      : Math.min(timeoutParsed, PREFLIGHT_TIMEOUT_CAP);
  return {
    command,
    args: kv["args"] === undefined ? [] : parseStringArray(kv["args"]),
    cwd: kv["cwd"] === undefined ? "." : parseString(kv["cwd"]),
    timeoutSeconds,
  };
}

export function parsePreflightConfig(source: string): PreflightConfig {
  const out = new Map<string, PreflightCommandConfig>();
  for (const [ns, kv] of collectPreflightKvSections(source).entries()) {
    const cfg = toPreflightCommandConfig(kv);
    if (cfg !== undefined) out.set(ns, cfg);
  }
  return out;
}

export function loadNimbusPreflightFromConfigDir(configDir: string): PreflightConfig {
  return loadTomlSectionFromConfig<PreflightConfig>(
    configDir,
    "federation.preflight",
    new Map(),
    parsePreflightConfig,
  );
}

// ---------------------------------------------------------------------------
// [tribal] — tribal-knowledge extraction (Phase 6 Slice 6c)
// ---------------------------------------------------------------------------

export type TribalMatchMode = "embedding" | "embedding+llm";

export type TribalNotionTarget = { databaseId: string };

export type TribalConfluenceTarget = { spaceKey: string; parentPageId: string };

export type NimbusTribalToml = {
  enabled: boolean;
  match: TribalMatchMode;
  minOccurrences: number;
  windowDays: number;
  cooldownDays: number;
  watchChannels: readonly string[];
  notion?: TribalNotionTarget;
  confluence?: TribalConfluenceTarget;
};

export const DEFAULT_NIMBUS_TRIBAL_TOML: NimbusTribalToml = {
  enabled: false,
  match: "embedding",
  minOccurrences: 3,
  windowDays: 14,
  cooldownDays: 30,
  watchChannels: [],
};

/** Apply one `[tribal]` key/value to the accumulator (silently ignores malformed/unknown entries). */
function applyTribalEntry(out: Partial<NimbusTribalToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      return;
    }
    case "match": {
      const v = parseString(valRaw);
      if (v === "embedding" || v === "embedding+llm") out.match = v;
      return;
    }
    case "min_occurrences": {
      const n = parseIntWithMin(valRaw, 1);
      if (n !== undefined) out.minOccurrences = n;
      return;
    }
    case "window_days": {
      const n = parseIntWithMin(valRaw, 1);
      if (n !== undefined) out.windowDays = n;
      return;
    }
    case "cooldown_days": {
      const n = parseIntWithMin(valRaw, 0);
      if (n !== undefined) out.cooldownDays = n;
      return;
    }
    case "watch_channels": {
      try {
        out.watchChannels = parseStringArray(valRaw);
      } catch {
        // malformed array — keep default
      }
      return;
    }
    default:
      return;
  }
}

function parseNimbusTomlTribalSection(source: string): Partial<NimbusTribalToml> {
  const out: Partial<NimbusTribalToml> = {};
  forEachSectionEntry(source, "[tribal]", (key, valRaw) => {
    applyTribalEntry(out, key, valRaw);
  });
  return out;
}

function parseTribalNotionTarget(source: string): TribalNotionTarget | undefined {
  let databaseId: string | undefined;
  forEachSectionEntry(source, "[tribal.notion]", (key, valRaw) => {
    if (key === "database_id") {
      const v = parseString(valRaw);
      if (v.length > 0) databaseId = v;
    }
  });
  return databaseId === undefined ? undefined : { databaseId };
}

function parseTribalConfluenceTarget(source: string): TribalConfluenceTarget | undefined {
  let spaceKey: string | undefined;
  let parentPageId: string | undefined;
  forEachSectionEntry(source, "[tribal.confluence]", (key, valRaw) => {
    if (key === "space_key") {
      const v = parseString(valRaw);
      if (v.length > 0) spaceKey = v;
    } else if (key === "parent_page_id") {
      const v = parseString(valRaw);
      if (v.length > 0) parentPageId = v;
    }
  });
  return spaceKey !== undefined && parentPageId !== undefined
    ? { spaceKey, parentPageId }
    : undefined;
}

export function parseNimbusTribalToml(
  raw: string,
  defaults: NimbusTribalToml = DEFAULT_NIMBUS_TRIBAL_TOML,
): NimbusTribalToml {
  const section = parseNimbusTomlTribalSection(raw);
  const result: NimbusTribalToml = { ...defaults, ...section };
  const notion = parseTribalNotionTarget(raw);
  if (notion !== undefined) result.notion = notion;
  const confluence = parseTribalConfluenceTarget(raw);
  if (confluence !== undefined) result.confluence = confluence;
  return result;
}

/**
 * Whether a config layer exists but cannot be read, so `loadNimbusTribalFromConfigDir` returned the
 * defaults for a reason other than "nothing configured". The KB refusals fail closed on it.
 */
export function nimbusTribalConfigUnreadable(configDir: string): boolean {
  return layerReadError(configDir) !== undefined;
}

export function loadNimbusTribalFromConfigDir(configDir: string): NimbusTribalToml {
  return loadTomlSectionFromConfig(
    configDir,
    "tribal",
    DEFAULT_NIMBUS_TRIBAL_TOML,
    parseNimbusTribalToml,
  );
}

// ---------------------------------------------------------------------------
// Share & Virality (Phase 6 Slice 8). `[share.http_sink]` is the config-pinned destination for the
// `--http` outbound-share sink (the only host it may POST to). The bearer token is Vault-only
// (Non-Negotiable #3): config holds ONLY the Vault key NAME (`auth_vault_key`), never the value. An
// empty/absent `url` leaves the http sink unconfigured → `share.create --http` fails closed.

export type NimbusShareHttpSink = {
  readonly url: string;
  readonly authHeaderName?: string;
  readonly authVaultKey?: string;
};

export const DEFAULT_NIMBUS_SHARE_HTTP_SINK: NimbusShareHttpSink = { url: "" };

export function parseNimbusShareHttpSink(raw: string): NimbusShareHttpSink {
  let url = "";
  let authHeaderName: string | undefined;
  let authVaultKey: string | undefined;
  forEachSectionEntry(raw, "[share.http_sink]", (key, valRaw) => {
    if (key === "url") {
      const v = parseString(valRaw);
      if (v.length > 0) url = v;
    } else if (key === "auth_header_name") {
      const v = parseString(valRaw);
      if (v.length > 0) authHeaderName = v;
    } else if (key === "auth_vault_key") {
      const v = parseString(valRaw);
      if (v.length > 0) authVaultKey = v;
    }
  });
  return {
    url,
    ...(authHeaderName === undefined ? {} : { authHeaderName }),
    ...(authVaultKey === undefined ? {} : { authVaultKey }),
  };
}

export function loadNimbusShareHttpSink(configDir: string): NimbusShareHttpSink {
  return loadTomlSectionFromConfig(
    configDir,
    "share.http_sink",
    DEFAULT_NIMBUS_SHARE_HTTP_SINK,
    parseNimbusShareHttpSink,
  );
}

// ---------------------------------------------------------------------------
// [briefs] — research briefs (Spine S1)
// ---------------------------------------------------------------------------
