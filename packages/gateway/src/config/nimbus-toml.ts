import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ServiceConfig } from "../metrics/dora-config.ts";
import { processEnvGet } from "../platform/env-access.ts";
import { parseNimbusCiServiceToml, parseNimbusDoraToml } from "./service-config-toml.ts";
import {
  hasUnterminatedString,
  isTableHeader,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

// Re-export the DORA / CI service-config surface so external importers
// (http-server.ts, ipc/server/dispatchers.ts, config + metrics tests) keep
// working through `./nimbus-toml.ts` unchanged.
export * from "./service-config-toml.ts";

function loadTomlSection<T>(tomlPath: string, fallback: T, parse: (raw: string) => T): T {
  if (!existsSync(tomlPath)) {
    return structuredClone(fallback);
  }
  try {
    return parse(readFileSync(tomlPath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

export type NimbusEmbeddingToml = {
  enabled: boolean;
  provider: "local" | "openai" | "hybrid";
  model: string;
  chunkTokens: number;
  chunkOverlapTokens: number;
  backfillBatchSize: number;
  pauseOnBattery: boolean;
};

export const DEFAULT_NIMBUS_EMBEDDING_TOML: NimbusEmbeddingToml = {
  enabled: true,
  provider: "local",
  model: "all-MiniLM-L6-v2",
  chunkTokens: 256,
  chunkOverlapTokens: 32,
  backfillBatchSize: 50,
  pauseOnBattery: true,
};

function parseBool(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  return undefined;
}

function forEachSectionEntry(
  source: string,
  sectionHeader: string,
  onEntry: (key: string, valRaw: string) => void,
): void {
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) {
      continue;
    }
    if (trimmed === "") {
      continue;
    }
    if (isTableHeader(trimmed)) {
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) {
      onEntry(kv.key, kv.valRaw);
    }
  }
}

function setEmbeddingEnabled(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.enabled = b;
  }
}

function setEmbeddingPauseOnBattery(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.pauseOnBattery = b;
  }
}

function setEmbeddingProvider(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const p = parseString(valRaw).toLowerCase();
  if (p === "local" || p === "openai" || p === "hybrid") {
    out.provider = p;
  }
}

function setEmbeddingPositiveInt(
  out: Partial<NimbusEmbeddingToml>,
  valRaw: string,
  field: "chunkTokens" | "backfillBatchSize",
): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n > 0) {
    out[field] = n;
  }
}

function setEmbeddingOverlapTokens(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= 0) {
    out.chunkOverlapTokens = n;
  }
}

function applyNimbusEmbeddingKey(
  out: Partial<NimbusEmbeddingToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled":
      setEmbeddingEnabled(out, valRaw);
      break;
    case "provider":
      setEmbeddingProvider(out, valRaw);
      break;
    case "model":
      out.model = parseString(valRaw);
      break;
    case "chunk_tokens":
      setEmbeddingPositiveInt(out, valRaw, "chunkTokens");
      break;
    case "chunk_overlap_tokens":
      setEmbeddingOverlapTokens(out, valRaw);
      break;
    case "backfill_batch_size":
      setEmbeddingPositiveInt(out, valRaw, "backfillBatchSize");
      break;
    case "pause_on_battery":
      setEmbeddingPauseOnBattery(out, valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlEmbeddingSection(source: string): Partial<NimbusEmbeddingToml> {
  const out: Partial<NimbusEmbeddingToml> = {};
  forEachSectionEntry(source, "[embedding]", (key, valRaw) => {
    applyNimbusEmbeddingKey(out, key, valRaw);
  });
  return out;
}

export function resolveNimbusTomlForProfile(configDir: string): string {
  const p = processEnvGet("NIMBUS_PROFILE")?.trim();
  if (p === undefined || p === "" || p === "default") {
    return join(configDir, "nimbus.toml");
  }
  const alt = join(configDir, `nimbus.${p}.toml`);
  return existsSync(alt) ? alt : join(configDir, "nimbus.toml");
}

export function loadNimbusEmbeddingFromPath(tomlPath: string): NimbusEmbeddingToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_EMBEDDING_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_EMBEDDING_TOML,
      ...parseNimbusTomlEmbeddingSection(raw),
    }),
  );
}

export function loadNimbusEmbeddingFromConfigDir(configDir: string): NimbusEmbeddingToml {
  return loadNimbusEmbeddingFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusLlmToml = {
  preferLocal: boolean;
  remoteModel: string;
  classifierModel: string;
  localModel: string;
  llamacppServerPath: string;
  minReasoningParams: number;
  enforceAirGap: boolean;
  maxAgentDepth: number;
  maxToolCallsPerSession: number;
};

export const DEFAULT_NIMBUS_LLM_TOML: NimbusLlmToml = {
  preferLocal: true,
  remoteModel: "claude-sonnet-4-6",
  classifierModel: "claude-haiku-4-5-20251001",
  localModel: "llama3.2",
  llamacppServerPath: "",
  minReasoningParams: 7,
  enforceAirGap: false,
  maxAgentDepth: 3,
  maxToolCallsPerSession: 20,
};

function applyNimbusLlmKey(out: Partial<NimbusLlmToml>, key: string, valRaw: string): void {
  switch (key) {
    case "prefer_local": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.preferLocal = b;
      break;
    }
    case "remote_model":
      out.remoteModel = parseString(valRaw);
      break;
    case "classifier_model":
      out.classifierModel = parseString(valRaw);
      break;
    case "local_model":
      out.localModel = parseString(valRaw);
      break;
    case "llamacpp_server_path":
      out.llamacppServerPath = parseString(valRaw);
      break;
    case "min_reasoning_params": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.minReasoningParams = n;
      break;
    }
    case "enforce_air_gap": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enforceAirGap = b;
      break;
    }
    case "max_agent_depth": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 1 && n <= 10) out.maxAgentDepth = n;
      break;
    }
    case "max_tool_calls_per_session": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 1 && n <= 200) out.maxToolCallsPerSession = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusTomlLlmSection(source: string): Partial<NimbusLlmToml> {
  const out: Partial<NimbusLlmToml> = {};
  forEachSectionEntry(source, "[llm]", (key, valRaw) => {
    applyNimbusLlmKey(out, key, valRaw);
  });
  return out;
}

export function loadNimbusLlmFromPath(tomlPath: string): NimbusLlmToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_LLM_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_LLM_TOML,
      ...parseNimbusTomlLlmSection(raw),
    }),
  );
}

export function loadNimbusLlmPartialFromPath(tomlPath: string): Partial<NimbusLlmToml> {
  return loadTomlSection<Partial<NimbusLlmToml>>(tomlPath, {}, parseNimbusTomlLlmSection);
}

export function loadNimbusLlmFromConfigDir(configDir: string): NimbusLlmToml {
  return loadNimbusLlmFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusVoiceToml = {
  enabled: boolean;
  whisperPath: string;
  whisperModel: string;
  wakeWordWhisperModel: string;
  wakeWord: string;
  piperPath: string;
  piperModel: string;
};

export const DEFAULT_NIMBUS_VOICE_TOML: NimbusVoiceToml = {
  enabled: false,
  whisperPath: "",
  whisperModel: "base.en",
  wakeWordWhisperModel: "tiny.en",
  wakeWord: "hey nimbus",
  piperPath: "",
  piperModel: "",
};

function applyNimbusVoiceKey(out: Partial<NimbusVoiceToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "whisper_path":
      out.whisperPath = parseString(valRaw);
      break;
    case "whisper_model":
      out.whisperModel = parseString(valRaw);
      break;
    case "wake_word_whisper_model":
      out.wakeWordWhisperModel = parseString(valRaw);
      break;
    case "wake_word":
      out.wakeWord = parseString(valRaw);
      break;
    case "piper_path":
      out.piperPath = parseString(valRaw);
      break;
    case "piper_model":
      out.piperModel = parseString(valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlVoiceSection(source: string): Partial<NimbusVoiceToml> {
  const out: Partial<NimbusVoiceToml> = {};
  forEachSectionEntry(source, "[voice]", (key, valRaw) => {
    applyNimbusVoiceKey(out, key, valRaw);
  });
  return out;
}

export function loadNimbusVoiceFromPath(tomlPath: string): NimbusVoiceToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_VOICE_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_VOICE_TOML,
      ...parseNimbusTomlVoiceSection(raw),
    }),
  );
}

export function loadNimbusVoiceFromConfigDir(configDir: string): NimbusVoiceToml {
  return loadNimbusVoiceFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusUpdaterToml = {
  enabled: boolean;
  url: string;
  checkOnStartup: boolean;
  autoApply: boolean;
};

export const DEFAULT_NIMBUS_UPDATER_TOML: NimbusUpdaterToml = {
  enabled: true,
  url: "https://github.com/nimbus-agent/Nimbus/releases/latest/download/latest.json",
  checkOnStartup: true,
  autoApply: false,
};

function applyNimbusUpdaterKey(out: Partial<NimbusUpdaterToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "url":
      out.url = parseString(valRaw);
      break;
    case "check_on_startup": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.checkOnStartup = b;
      break;
    }
    case "auto_apply": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.autoApply = b;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusTomlUpdaterSection(source: string): Partial<NimbusUpdaterToml> {
  const out: Partial<NimbusUpdaterToml> = {};
  forEachSectionEntry(source, "[updater]", (key, valRaw) => {
    applyNimbusUpdaterKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusUpdaterToml(
  raw: string,
  defaults: NimbusUpdaterToml = DEFAULT_NIMBUS_UPDATER_TOML,
): NimbusUpdaterToml {
  const section = parseNimbusTomlUpdaterSection(raw);
  const result: NimbusUpdaterToml = { ...defaults, ...section };

  const urlOverride = processEnvGet("NIMBUS_UPDATER_URL");
  if (urlOverride) {
    result.url = urlOverride;
  }
  if (processEnvGet("NIMBUS_UPDATER_DISABLE") === "1") {
    result.enabled = false;
  }
  return result;
}

export function loadNimbusUpdaterFromPath(tomlPath: string): NimbusUpdaterToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_UPDATER_TOML, parseNimbusUpdaterToml);
}

export function loadNimbusUpdaterFromConfigDir(configDir: string): NimbusUpdaterToml {
  return loadNimbusUpdaterFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusLanToml = {
  enabled: boolean;
  port: number;
  bind: string;
  pairingWindowSeconds: number;
  maxFailedAttempts: number;
  lockoutSeconds: number;
};

export const DEFAULT_NIMBUS_LAN_TOML: NimbusLanToml = {
  enabled: false,
  port: 7475,
  bind: "127.0.0.1",
  pairingWindowSeconds: 300,
  maxFailedAttempts: 3,
  lockoutSeconds: 60,
};

function applyNimbusLanKey(out: Partial<NimbusLanToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "port": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.port = n;
      break;
    }
    case "bind":
      out.bind = parseString(valRaw);
      break;
    case "pairing_window_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.pairingWindowSeconds = n;
      break;
    }
    case "max_failed_attempts": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxFailedAttempts = n;
      break;
    }
    case "lockout_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.lockoutSeconds = n;
      break;
    }
    default:
      break;
  }
}

function parseNimbusTomlLanSection(source: string): Partial<NimbusLanToml> {
  const out: Partial<NimbusLanToml> = {};
  forEachSectionEntry(source, "[lan]", (key, valRaw) => {
    applyNimbusLanKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusLanToml(
  raw: string,
  defaults: NimbusLanToml = DEFAULT_NIMBUS_LAN_TOML,
): NimbusLanToml {
  const section = parseNimbusTomlLanSection(raw);
  const result: NimbusLanToml = { ...defaults, ...section };

  const portOverride = processEnvGet("NIMBUS_LAN_PORT");
  if (portOverride) {
    const parsed = Number.parseInt(portOverride, 10);
    if (!Number.isNaN(parsed)) result.port = parsed;
  }
  return result;
}

export function loadNimbusLanFromPath(tomlPath: string): NimbusLanToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_LAN_TOML, parseNimbusLanToml);
}

export function loadNimbusLanFromConfigDir(configDir: string): NimbusLanToml {
  return loadNimbusLanFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusFederationToml = {
  enabled: boolean;
  consentTimeoutSeconds: number;
  mdnsEnabled: boolean;
  mdnsBind: string;
};

export const DEFAULT_NIMBUS_FEDERATION_TOML: NimbusFederationToml = {
  enabled: false,
  consentTimeoutSeconds: 30,
  mdnsEnabled: true,
  mdnsBind: "0.0.0.0",
};

function applyNimbusFederationKey(
  out: Partial<NimbusFederationToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "consent_timeout_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0 && n <= 3600) out.consentTimeoutSeconds = n;
      break;
    }
    case "mdns_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.mdnsEnabled = b;
      break;
    }
    case "mdns_bind":
      out.mdnsBind = parseString(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlFederationSection(source: string): Partial<NimbusFederationToml> {
  const out: Partial<NimbusFederationToml> = {};
  forEachSectionEntry(source, "[federation]", (key, valRaw) => {
    applyNimbusFederationKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusFederationToml(
  raw: string,
  defaults: NimbusFederationToml = DEFAULT_NIMBUS_FEDERATION_TOML,
): NimbusFederationToml {
  const section = parseNimbusTomlFederationSection(raw);
  return { ...defaults, ...section };
}

export function loadNimbusFederationFromPath(tomlPath: string): NimbusFederationToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_FEDERATION_TOML, parseNimbusFederationToml);
}

export function loadNimbusFederationFromConfigDir(configDir: string): NimbusFederationToml {
  return loadNimbusFederationFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusAutomationToml = {
  graphConditions: boolean;
};

export const DEFAULT_NIMBUS_AUTOMATION_TOML: NimbusAutomationToml = {
  graphConditions: true,
};

function parseNimbusTomlAutomationSection(source: string): Partial<NimbusAutomationToml> {
  const out: Partial<NimbusAutomationToml> = {};
  forEachSectionEntry(source, "[automation]", (key, valRaw) => {
    if (key === "graph_conditions") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.graphConditions = b;
    }
  });
  return out;
}

export function parseNimbusAutomationToml(
  raw: string,
  defaults: NimbusAutomationToml = DEFAULT_NIMBUS_AUTOMATION_TOML,
): NimbusAutomationToml {
  return { ...defaults, ...parseNimbusTomlAutomationSection(raw) };
}

export function loadNimbusAutomationFromPath(tomlPath: string): NimbusAutomationToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AUTOMATION_TOML, parseNimbusAutomationToml);
}

export function loadNimbusAutomationFromConfigDir(configDir: string): NimbusAutomationToml {
  return loadNimbusAutomationFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusExtensionsToml = {
  updateCheckIntervalHours: number;
};

export const DEFAULT_NIMBUS_EXTENSIONS_TOML: NimbusExtensionsToml = {
  updateCheckIntervalHours: 24,
};

function parseUpdateCheckIntervalHours(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(
      `[extensions].update_check_interval_hours must be an integer (got: ${valRaw})`,
    );
  }
  if (n < 1 || n > 168) {
    throw new Error(`[extensions].update_check_interval_hours must be in [1, 168] (got: ${n})`);
  }
  return n;
}

function parseNimbusTomlExtensionsSection(source: string): Partial<NimbusExtensionsToml> {
  const out: Partial<NimbusExtensionsToml> = {};
  forEachSectionEntry(source, "[extensions]", (key, valRaw) => {
    if (key === "update_check_interval_hours") {
      out.updateCheckIntervalHours = parseUpdateCheckIntervalHours(valRaw);
    }
  });
  return out;
}

export function parseNimbusExtensionsToml(
  raw: string,
  defaults: NimbusExtensionsToml = DEFAULT_NIMBUS_EXTENSIONS_TOML,
): NimbusExtensionsToml {
  return { ...defaults, ...parseNimbusTomlExtensionsSection(raw) };
}

export function loadNimbusExtensionsFromPath(tomlPath: string): NimbusExtensionsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_EXTENSIONS_TOML, parseNimbusExtensionsToml);
}

export function loadNimbusExtensionsFromConfigDir(configDir: string): NimbusExtensionsToml {
  return loadNimbusExtensionsFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusAuditToml = {
  // 0 disables pruning (rows kept forever). > 0 = delete tool_call_log rows
  // older than N days on the daily retention job.
  toolCallLogRetentionDays: number;
};

export const DEFAULT_NIMBUS_AUDIT_TOML: NimbusAuditToml = {
  toolCallLogRetentionDays: 90,
};

function parseToolCallLogRetentionDays(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(`[audit].tool_call_log_retention_days must be an integer (got: ${valRaw})`);
  }
  if (n < 0 || n > 36_500) {
    throw new Error(`[audit].tool_call_log_retention_days must be in [0, 36500] (got: ${n})`);
  }
  return n;
}

function parseNimbusTomlAuditSection(source: string): Partial<NimbusAuditToml> {
  const out: Partial<NimbusAuditToml> = {};
  forEachSectionEntry(source, "[audit]", (key, valRaw) => {
    if (key === "tool_call_log_retention_days") {
      out.toolCallLogRetentionDays = parseToolCallLogRetentionDays(valRaw);
    }
  });
  return out;
}

export function parseNimbusAuditToml(
  raw: string,
  defaults: NimbusAuditToml = DEFAULT_NIMBUS_AUDIT_TOML,
): NimbusAuditToml {
  return { ...defaults, ...parseNimbusTomlAuditSection(raw) };
}

export function loadNimbusAuditFromPath(tomlPath: string): NimbusAuditToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AUDIT_TOML, parseNimbusAuditToml);
}

export function loadNimbusAuditFromConfigDir(configDir: string): NimbusAuditToml {
  return loadNimbusAuditFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusSecurityToml = {
  extendedPatterns: boolean;
  allowlistFingerprints: string[];
};

export const DEFAULT_NIMBUS_SECURITY_TOML: NimbusSecurityToml = {
  extendedPatterns: false,
  allowlistFingerprints: [],
};

function parseNimbusTomlSecuritySection(source: string): Partial<NimbusSecurityToml> {
  const out: Partial<NimbusSecurityToml> = {};
  forEachSectionEntry(source, "[security]", (key, valRaw) => {
    if (key === "extended_patterns") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.extendedPatterns = b;
    }
  });
  // [[security.allowlist]] is an array-of-tables; collect each entry's fingerprint.
  const fps: string[] = [];
  let inAllow = false;
  for (const line of source.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (t === "") continue;
    if (isTableHeader(t)) {
      inAllow = t === "[[security.allowlist]]";
      continue;
    }
    if (!inAllow) continue;
    const kv = splitKeyValue(t);
    if (kv?.key === "fingerprint") {
      const v = parseString(kv.valRaw);
      if (v.length > 0) fps.push(v);
    }
  }
  if (fps.length > 0) out.allowlistFingerprints = fps;
  return out;
}

export function parseNimbusSecurityToml(
  raw: string,
  defaults: NimbusSecurityToml = DEFAULT_NIMBUS_SECURITY_TOML,
): NimbusSecurityToml {
  return { ...defaults, ...parseNimbusTomlSecuritySection(raw) };
}

export function loadNimbusSecurityFromPath(tomlPath: string): NimbusSecurityToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_SECURITY_TOML, parseNimbusSecurityToml);
}

export function loadNimbusSecurityFromConfigDir(configDir: string): NimbusSecurityToml {
  return loadNimbusSecurityFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusUserToml = {
  mePersonId?: string;
};

export const DEFAULT_NIMBUS_USER_TOML: NimbusUserToml = {};

function parseNimbusTomlUserSection(source: string): Partial<NimbusUserToml> {
  const out: Partial<NimbusUserToml> = {};
  forEachSectionEntry(source, "[user]", (key, valRaw) => {
    if (key === "me_person_id") {
      const v = parseString(valRaw);
      if (v.length > 0) out.mePersonId = v;
    }
  });
  return out;
}

export function parseNimbusUserToml(
  raw: string,
  defaults: NimbusUserToml = DEFAULT_NIMBUS_USER_TOML,
): NimbusUserToml {
  return { ...defaults, ...parseNimbusTomlUserSection(raw) };
}

export function loadNimbusUserFromPath(tomlPath: string): NimbusUserToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_USER_TOML, parseNimbusUserToml);
}

export function loadNimbusUserFromConfigDir(configDir: string): NimbusUserToml {
  return loadNimbusUserFromPath(join(configDir, "nimbus.toml"));
}

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
  try {
    return parseNimbusPagerdutyToml(raw);
  } catch (err) {
    process.stderr.write(
      `nimbus: [pagerduty] config in ${tomlPath} rejected, using defaults: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
}

export function loadNimbusPagerdutyFromConfigDir(configDir: string): NimbusPagerdutyToml {
  return loadNimbusPagerdutyFromPath(join(configDir, "nimbus.toml"));
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_IDENTITY_TOML,
    parseNimbusIdentityToml,
  );
}

// ---------------------------------------------------------------------------
// [hitl.quorum] — per-action-type quorum rules
// ---------------------------------------------------------------------------

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
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      currentId = beginQuorumTable(accum, trimmed);
      continue;
    }
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/**
 * If `trimmed` is a `[hitl.quorum."<action-type>"]` header with a non-empty id,
 * ensures a bucket exists in `accum` and returns the id; otherwise returns undefined.
 */
function beginQuorumTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
): string | undefined {
  if (!trimmed.startsWith(HITL_QUORUM_TABLE_PREFIX) || !trimmed.endsWith('"]')) return undefined;
  const id = trimmed.slice(HITL_QUORUM_TABLE_PREFIX.length, -2);
  if (id.length === 0) return undefined;
  if (!accum.has(id)) accum.set(id, {});
  return id;
}

/** Records a `key = value` line into the current sub-table's bucket, if any. */
function applyKvLine(bucket: Record<string, string> | undefined, trimmed: string): void {
  if (bucket === undefined) return;
  const kv = splitKeyValue(trimmed);
  if (kv !== undefined) bucket[kv.key] = kv.valRaw;
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
  return loadNimbusQuorumFromPath(join(configDir, "nimbus.toml"));
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_CHATOPS_TOML,
    parseNimbusChatopsToml,
  );
}

// ---------------------------------------------------------------------------
// [federation.preflight."<namespace>"] — per-namespace downstream preflight command (I24)
// ---------------------------------------------------------------------------

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
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      currentId = beginPreflightTable(accum, trimmed);
      continue;
    }
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/**
 * If `trimmed` is a `[federation.preflight."<namespace>"]` header with a non-empty id,
 * ensures a bucket exists in `accum` and returns the id; otherwise returns undefined.
 */
function beginPreflightTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
): string | undefined {
  if (!trimmed.startsWith(PREFLIGHT_TABLE_PREFIX) || !trimmed.endsWith('"]')) return undefined;
  const id = trimmed.slice(PREFLIGHT_TABLE_PREFIX.length, -2);
  if (id.length === 0) return undefined;
  if (!accum.has(id)) accum.set(id, {});
  return id;
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
  return loadTomlSection<PreflightConfig>(
    join(configDir, "nimbus.toml"),
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

/** Parse an integer kv value with a minimum floor; returns undefined when absent/non-numeric/below `min`. */
function parseIntWithMin(valRaw: string, min: number): number | undefined {
  const n = parseIntDec(valRaw);
  return n !== undefined && n >= min ? n : undefined;
}

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

export function loadNimbusTribalFromConfigDir(configDir: string): NimbusTribalToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_SHARE_HTTP_SINK,
    parseNimbusShareHttpSink,
  );
}

// ---------------------------------------------------------------------------
// [briefs] — research briefs (Spine S1)
// ---------------------------------------------------------------------------

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
  if (key === "enabled") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.enabled = b;
    return;
  }
  if (key === "use_llm") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.useLlm = b;
    return;
  }
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
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
  if (key === "enabled") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.enabled = b;
    return;
  }
  if (key === "use_llm") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.useLlm = b;
    return;
  }
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
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_DECISIONS_TOML,
    parseNimbusDecisionsToml,
  );
}

// ---------------------------------------------------------------------------

// The DORA / CI service-config machinery (parsing + materialization) lives in
// `./service-config-toml.ts` and is re-exported from this module via the
// `export *` barrel near the top. `loadNimbusServiceConfigsFromConfigDir`
// stays here because it bridges that machinery with the `[pagerduty]` section
// parser (`parseNimbusPagerdutyToml`) defined above — keeping it here avoids a
// `service-config-toml.ts` → `nimbus-toml.ts` circular import.
export function loadNimbusServiceConfigsFromConfigDir(
  configDir: string,
): Map<string, ServiceConfig> {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return new Map();
  const raw = readFileSync(tomlPath, "utf8");
  const dora = parseNimbusDoraToml(raw);
  const ci = parseNimbusCiServiceToml(raw);
  const pagerdutyCfg = parseNimbusPagerdutyToml(raw);
  const aliases = pagerdutyCfg.severityP1Aliases;
  const merged: Map<string, ServiceConfig> = new Map();
  for (const [id, cfg] of dora.entries()) {
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  for (const [id, cfg] of ci.entries()) {
    if (merged.has(id)) {
      process.stderr.write(
        `[ci.service.${id}] and [metrics.dora.${id}] both define service '${id}'; ` +
          `using [ci.service.${id}].\n`,
      );
    }
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  return merged;
}

export {
  type ConnectorCredentialConfig,
  type ConnectorsConfig,
  loadNimbusConnectorsFromConfigDir,
  parseNimbusConnectorsToml,
  TEAM_CREDENTIAL_CONNECTORS,
  type TeamCredentialConnector,
} from "./nimbus-toml-connectors.ts";
