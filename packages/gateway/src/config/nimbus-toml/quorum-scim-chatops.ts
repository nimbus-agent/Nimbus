import { parseBool, parseIntDec, parseString } from "../toml-primitives.ts";
import {
  beginQuotedIdTable,
  collectSubTableKv,
  forEachSectionEntry,
  loadTomlSection,
  loadTomlSectionFromConfig,
} from "./shared.ts";

export interface QuorumRule {
  readonly approvers: number;
  readonly windowSeconds: number;
}

export type QuorumConfig = ReadonlyMap<string, QuorumRule>;

const HITL_QUORUM_TABLE_PREFIX = '[hitl.quorum."';

/**
 * Parse the `[hitl.quorum."<action-type>"]` sub-tables from a raw nimbus.toml
 * string into a QuorumConfig map.
 *
 * Each sub-table must have:
 *   approvers    = <integer >= 1>
 *   window_seconds = <integer > 0>
 *
 * Malformed rows (missing/non-numeric values, approvers < 1, window <= 0) are
 * silently ignored. Returns an empty map when the section is absent (quorum off).
 */
export function parseQuorumConfig(source: string): QuorumConfig {
  const out = new Map<string, QuorumRule>();
  for (const [actionType, kv] of collectQuorumKvSections(source).entries()) {
    const rule = toQuorumRule(kv);
    if (rule !== undefined) out.set(actionType, rule);
  }
  return out;
}

/** Accumulates raw kv strings per `[hitl.quorum."<action-type>"]` sub-table. */
function collectQuorumKvSections(source: string): Map<string, Record<string, string>> {
  return collectSubTableKv(source, (accum, trimmed) =>
    beginQuotedIdTable(accum, trimmed, HITL_QUORUM_TABLE_PREFIX),
  );
}

/**
 * Validates one sub-table's raw kv strings into a QuorumRule, or undefined when
 * malformed (missing/non-numeric values, approvers < 1, window_seconds <= 0).
 */
function toQuorumRule(kv: Record<string, string>): QuorumRule | undefined {
  const approversRaw = kv["approvers"];
  const windowRaw = kv["window_seconds"];
  if (approversRaw === undefined || windowRaw === undefined) return undefined;
  const approvers = parseIntDec(approversRaw);
  const windowSeconds = parseIntDec(windowRaw);
  if (approvers === undefined || windowSeconds === undefined) return undefined;
  if (approvers < 1 || windowSeconds <= 0) return undefined;
  return { approvers, windowSeconds };
}

export function loadNimbusQuorumFromPath(tomlPath: string): QuorumConfig {
  return loadTomlSection<QuorumConfig>(tomlPath, new Map(), parseQuorumConfig);
}

export function loadNimbusQuorumFromConfigDir(configDir: string): QuorumConfig {
  return loadTomlSectionFromConfig<QuorumConfig>(
    configDir,
    "hitl.quorum",
    new Map(),
    parseQuorumConfig,
  );
}

// ---------------------------------------------------------------------------

export type NimbusScimToml = { enabled: boolean };
export const DEFAULT_NIMBUS_SCIM_TOML: NimbusScimToml = { enabled: false };

export function parseNimbusScimToml(
  raw: string,
  defaults: NimbusScimToml = DEFAULT_NIMBUS_SCIM_TOML,
): NimbusScimToml {
  const out: Partial<NimbusScimToml> = {};
  forEachSectionEntry(raw, "[scim]", (key, valRaw) => {
    if (key === "enabled") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
    }
  });
  return { ...defaults, ...out };
}

export function loadNimbusScimFromConfigDir(configDir: string): NimbusScimToml {
  return loadTomlSectionFromConfig(
    configDir,
    "scim",
    DEFAULT_NIMBUS_SCIM_TOML,
    parseNimbusScimToml,
  );
}

// ---------------------------------------------------------------------------
// [chatops] — ChatOps bridge (Phase 6 Slice 5)
// ---------------------------------------------------------------------------

export type NimbusChatopsToml = {
  enabled: boolean;
  slackEnabled: boolean;
  teamsEnabled: boolean;
  /** Team Vault entry name holding the bot tokens (Slice 2). */
  botVaultEntry: string;
  /** TTL for the platform-userId -> email mapping cache (authz is always re-checked live). */
  identityCacheTtlSeconds: number;
  /** Teams bot app id; the `aud` claim the Bot Framework JWT must carry. */
  teamsBotAppId: string;
};

export const DEFAULT_NIMBUS_CHATOPS_TOML: NimbusChatopsToml = {
  enabled: false,
  slackEnabled: false,
  teamsEnabled: false,
  botVaultEntry: "chatops-bot",
  identityCacheTtlSeconds: 900,
  teamsBotAppId: "",
};

function applyNimbusChatopsKey(out: Partial<NimbusChatopsToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "slack_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.slackEnabled = b;
      break;
    }
    case "teams_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.teamsEnabled = b;
      break;
    }
    case "bot_vault_entry":
      out.botVaultEntry = parseString(valRaw);
      break;
    case "teams_bot_app_id":
      out.teamsBotAppId = parseString(valRaw);
      break;
    case "identity_cache_ttl_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.identityCacheTtlSeconds = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusChatopsToml(
  raw: string,
  defaults: NimbusChatopsToml = DEFAULT_NIMBUS_CHATOPS_TOML,
): NimbusChatopsToml {
  const out: Partial<NimbusChatopsToml> = {};
  forEachSectionEntry(raw, "[chatops]", (key, valRaw) => applyNimbusChatopsKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusChatopsFromConfigDir(configDir: string): NimbusChatopsToml {
  return loadTomlSectionFromConfig(
    configDir,
    "chatops",
    DEFAULT_NIMBUS_CHATOPS_TOML,
    parseNimbusChatopsToml,
  );
}

// ---------------------------------------------------------------------------
// [federation.preflight."<namespace>"] — per-namespace downstream preflight command (I24)
// ---------------------------------------------------------------------------
