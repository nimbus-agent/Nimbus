import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_DEPLOY_ENVIRONMENTS,
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  DEFAULT_EXCLUDE_PR_LABELS,
  DEFAULT_INCIDENT_WINDOW_MINUTES,
  isValidDeployEnvironmentName,
  parseDoraRepoUrn,
  type ServiceConfig,
} from "../metrics/dora-config.ts";
import { processEnvGet } from "../platform/env-access.ts";

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

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
}

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

function parseString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replaceAll(String.raw`\\"`, '"');
  }
  return t;
}

function parseIntDec(raw: string): number | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function isTableHeader(trimmed: string): boolean {
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function splitKeyValue(trimmed: string): { key: string; valRaw: string } | undefined {
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return undefined;
  }
  return { key: trimmed.slice(0, eq).trim(), valRaw: trimmed.slice(eq + 1).trim() };
}

function forEachSectionEntry(
  source: string,
  sectionHeader: string,
  onEntry: (key: string, valRaw: string) => void,
): void {
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_EMBEDDING_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return structuredClone({
      ...DEFAULT_NIMBUS_EMBEDDING_TOML,
      ...parseNimbusTomlEmbeddingSection(raw),
    });
  } catch {
    return structuredClone(DEFAULT_NIMBUS_EMBEDDING_TOML);
  }
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_LLM_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return structuredClone({
      ...DEFAULT_NIMBUS_LLM_TOML,
      ...parseNimbusTomlLlmSection(raw),
    });
  } catch {
    return structuredClone(DEFAULT_NIMBUS_LLM_TOML);
  }
}

export function loadNimbusLlmPartialFromPath(tomlPath: string): Partial<NimbusLlmToml> {
  if (!existsSync(tomlPath)) {
    return {};
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusTomlLlmSection(raw);
  } catch {
    return {};
  }
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_VOICE_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return structuredClone({
      ...DEFAULT_NIMBUS_VOICE_TOML,
      ...parseNimbusTomlVoiceSection(raw),
    });
  } catch {
    return structuredClone(DEFAULT_NIMBUS_VOICE_TOML);
  }
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_UPDATER_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusUpdaterToml(raw);
  } catch {
    return structuredClone(DEFAULT_NIMBUS_UPDATER_TOML);
  }
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_LAN_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusLanToml(raw);
  } catch {
    return structuredClone(DEFAULT_NIMBUS_LAN_TOML);
  }
}

export function loadNimbusLanFromConfigDir(configDir: string): NimbusLanToml {
  return loadNimbusLanFromPath(join(configDir, "nimbus.toml"));
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_AUTOMATION_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusAutomationToml(raw);
  } catch {
    return structuredClone(DEFAULT_NIMBUS_AUTOMATION_TOML);
  }
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
    throw new Error(`[extensions].update_check_interval_hours must be an integer (got: ${valRaw})`);
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_EXTENSIONS_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusExtensionsToml(raw);
  } catch {
    return structuredClone(DEFAULT_NIMBUS_EXTENSIONS_TOML);
  }
}

export function loadNimbusExtensionsFromConfigDir(configDir: string): NimbusExtensionsToml {
  return loadNimbusExtensionsFromPath(join(configDir, "nimbus.toml"));
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
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_USER_TOML);
  }
  try {
    const raw = readFileSync(tomlPath, "utf8");
    return parseNimbusUserToml(raw);
  } catch {
    return structuredClone(DEFAULT_NIMBUS_USER_TOML);
  }
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

const DORA_TABLE_PREFIX = "[metrics.dora.";
const SERVICE_CONFIG_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "repos",
  "pagerduty_services",
  "deploy_workflow_pattern",
  "incident_window_minutes",
  "exclude_pr_labels",
  "deploy_environments",
]);

function parseStringArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new Error(`expected array, got: ${raw}`);
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const v = parseString(part);
    if (v.length > 0) out.push(v);
  }
  return out;
}

function materializeDeployWorkflowPattern(
  kv: Record<string, string>,
  blockLabel: string,
  serviceId: string,
): RegExp {
  const patternSrc =
    kv["deploy_workflow_pattern"] === undefined
      ? DEFAULT_DEPLOY_WORKFLOW_PATTERN
      : parseString(kv["deploy_workflow_pattern"]);
  try {
    return new RegExp(patternSrc);
  } catch (e) {
    throw new Error(
      `[${blockLabel}.${serviceId}].deploy_workflow_pattern is not a valid regex: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

function materializeIncidentWindowMinutes(
  kv: Record<string, string>,
  blockLabel: string,
  serviceId: string,
): number {
  const windowRaw = kv["incident_window_minutes"];
  const windowMins =
    windowRaw === undefined ? DEFAULT_INCIDENT_WINDOW_MINUTES : parseIntDec(windowRaw);
  if (windowMins === undefined || windowMins < 1 || windowMins > 1440) {
    throw new Error(
      `[${blockLabel}.${serviceId}].incident_window_minutes must be 1..1440, got '${windowRaw}'`,
    );
  }
  return windowMins;
}

function materializeDeployEnvironments(
  kv: Record<string, string>,
  blockLabel: string,
  serviceId: string,
): string[] {
  const raw = kv["deploy_environments"];
  const deployEnvironments =
    raw === undefined ? Array.from(DEFAULT_DEPLOY_ENVIRONMENTS) : parseStringArray(raw);
  if (deployEnvironments.length === 0) {
    throw new Error(
      `[${blockLabel}.${serviceId}].deploy_environments must be a non-empty array of names`,
    );
  }
  for (const env of deployEnvironments) {
    if (!isValidDeployEnvironmentName(env)) {
      throw new Error(
        `[${blockLabel}.${serviceId}].deploy_environments entry '${env}' is invalid: ` +
          `must match /^[a-z0-9][a-z0-9._-]*$/`,
      );
    }
  }
  return deployEnvironments;
}

function materializeOneServiceConfig(
  serviceId: string,
  kv: Record<string, string>,
  blockLabel: string,
): ServiceConfig {
  const reposRaw = kv["repos"];
  if (reposRaw === undefined) {
    throw new Error(`[${blockLabel}.${serviceId}] missing required 'repos'`);
  }
  return {
    serviceId,
    repos: parseStringArray(reposRaw).map(parseDoraRepoUrn),
    pagerdutyServices:
      kv["pagerduty_services"] === undefined ? [] : parseStringArray(kv["pagerduty_services"]),
    deployWorkflowPattern: materializeDeployWorkflowPattern(kv, blockLabel, serviceId),
    incidentWindowMinutes: materializeIncidentWindowMinutes(kv, blockLabel, serviceId),
    excludePrLabels:
      kv["exclude_pr_labels"] === undefined
        ? Array.from(DEFAULT_EXCLUDE_PR_LABELS)
        : parseStringArray(kv["exclude_pr_labels"]),
    deployEnvironments: materializeDeployEnvironments(kv, blockLabel, serviceId),
    severityP1Aliases: [], // attached by loadNimbusServiceConfigsFromConfigDir
  };
}

function materializeServiceConfigs(
  accum: Map<string, Record<string, string>>,
  blockLabel: string,
): Map<string, ServiceConfig> {
  const out: Map<string, ServiceConfig> = new Map();
  for (const [serviceId, kv] of accum.entries()) {
    out.set(serviceId, materializeOneServiceConfig(serviceId, kv, blockLabel));
  }
  return out;
}

function accumulateServiceTables(
  raw: string,
  tablePrefix: string,
  blockLabel: string,
): Map<string, Record<string, string>> {
  const accum: Map<string, Record<string, string>> = new Map();
  let currentId: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      if (trimmed.startsWith(tablePrefix)) {
        const id = trimmed.slice(tablePrefix.length, -1);
        if (id.length === 0) throw new Error(`empty service id in [${blockLabel}.<id>]`);
        currentId = id;
        if (!accum.has(id)) accum.set(id, {});
      } else {
        currentId = undefined;
      }
      continue;
    }
    if (currentId === undefined) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    if (!SERVICE_CONFIG_KNOWN_KEYS.has(kv.key)) {
      throw new Error(`unknown key '${kv.key}' in [${blockLabel}.${currentId}]`);
    }
    const bucket = accum.get(currentId);
    if (bucket !== undefined) {
      bucket[kv.key] = kv.valRaw;
    }
  }
  return accum;
}

export function parseNimbusDoraToml(raw: string): Map<string, ServiceConfig> {
  return materializeServiceConfigs(
    accumulateServiceTables(raw, DORA_TABLE_PREFIX, "metrics.dora"),
    "metrics.dora",
  );
}

export function loadNimbusDoraFromPath(tomlPath: string): Map<string, ServiceConfig> {
  if (!existsSync(tomlPath)) return new Map();
  const raw = readFileSync(tomlPath, "utf8");
  return parseNimbusDoraToml(raw);
}

export function loadNimbusDoraFromConfigDir(configDir: string): Map<string, ServiceConfig> {
  return loadNimbusDoraFromPath(join(configDir, "nimbus.toml"));
}

const CI_SERVICE_TABLE_PREFIX = "[ci.service.";

export function parseNimbusCiServiceToml(raw: string): Map<string, ServiceConfig> {
  return materializeServiceConfigs(
    accumulateServiceTables(raw, CI_SERVICE_TABLE_PREFIX, "ci.service"),
    "ci.service",
  );
}

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
