import {
  hasUnterminatedString,
  isTableHeader,
  parseBool,
  parseString,
  splitKeyValue,
  stripComment,
} from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

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
  return loadTomlSectionFromConfig(
    configDir,
    "audit",
    DEFAULT_NIMBUS_AUDIT_TOML,
    parseNimbusAuditToml,
  );
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
  return loadTomlSectionFromConfig(
    configDir,
    "security",
    DEFAULT_NIMBUS_SECURITY_TOML,
    parseNimbusSecurityToml,
  );
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
  return loadTomlSectionFromConfig(
    configDir,
    "user",
    DEFAULT_NIMBUS_USER_TOML,
    parseNimbusUserToml,
  );
}
