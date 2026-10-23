import { existsSync, readFileSync } from "node:fs";
import { processEnvGet } from "../platform/env-access.ts";
import {
  fallbackMessage,
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import { parseBool } from "./toml-primitives.ts";

export type NimbusTelemetryToml = {
  enabled: boolean;
  endpoint: string;
  flushIntervalSeconds: number;
};

export const DEFAULT_NIMBUS_TELEMETRY_TOML: NimbusTelemetryToml = {
  enabled: false,
  endpoint: "https://telemetry.nimbus-agent.dev/v1/ingest",
  flushIntervalSeconds: 3600,
};

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
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

function applyTelemetryKv(out: Partial<NimbusTelemetryToml>, key: string, valRaw: string): void {
  if (key === "enabled") {
    const b = parseBool(valRaw);
    if (b !== undefined) {
      out.enabled = b;
    }
    return;
  }
  if (key === "endpoint") {
    const u = parseString(valRaw);
    if (u !== "") {
      out.endpoint = u;
    }
    return;
  }
  if (key === "flush_interval_seconds") {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) {
      out.flushIntervalSeconds = n;
    }
  }
}

export function parseNimbusTomlTelemetrySection(source: string): Partial<NimbusTelemetryToml> {
  const lines = source.split(/\r?\n/);
  let inTelemetry = false;
  const out: Partial<NimbusTelemetryToml> = {};

  for (const line of lines) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inTelemetry = trimmed === "[telemetry]";
      continue;
    }
    if (inTelemetry) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const valRaw = trimmed.slice(eq + 1).trim();
        applyTelemetryKv(out, key, valRaw);
      }
    }
  }
  return out;
}

export function loadNimbusTelemetryFromPath(tomlPath: string): NimbusTelemetryToml {
  let raw: string | null;
  try {
    raw = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  } catch {
    return applyTelemetryEnvOverrides({ ...DEFAULT_NIMBUS_TELEMETRY_TOML });
  }
  return loadNimbusTelemetryFromText(raw);
}

/** `[telemetry]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusTelemetryFromConfigDir(configDir: string): NimbusTelemetryToml {
  return loadNimbusTelemetryFromText(
    layeredConfigText(configDir),
    sectionFallbackSink(configDir, "telemetry"),
  );
}

/** The one `[telemetry]` core: env overrides apply on no file, a parse error, or a good parse. */
function loadNimbusTelemetryFromText(
  raw: string | null,
  onFallback?: SectionFallbackSink,
): NimbusTelemetryToml {
  if (raw === null) {
    return applyTelemetryEnvOverrides({ ...DEFAULT_NIMBUS_TELEMETRY_TOML });
  }
  try {
    return applyTelemetryEnvOverrides({
      ...DEFAULT_NIMBUS_TELEMETRY_TOML,
      ...parseNimbusTomlTelemetrySection(raw),
    });
  } catch (err) {
    onFallback?.(fallbackMessage(err));
    return applyTelemetryEnvOverrides({ ...DEFAULT_NIMBUS_TELEMETRY_TOML });
  }
}

function applyTelemetryEnvOverrides(base: NimbusTelemetryToml): NimbusTelemetryToml {
  const en = processEnvGet("NIMBUS_TELEMETRY_ENABLED")?.trim().toLowerCase();
  if (en === "1" || en === "true") {
    base.enabled = true;
  }
  if (en === "0" || en === "false") {
    base.enabled = false;
  }
  const ep = processEnvGet("NIMBUS_TELEMETRY_ENDPOINT")?.trim();
  if (ep !== undefined && ep !== "") {
    base.endpoint = ep;
  }
  const fl = processEnvGet("NIMBUS_TELEMETRY_FLUSH_SECONDS")?.trim();
  if (fl !== undefined && fl !== "") {
    const n = Number.parseInt(fl, 10);
    if (Number.isFinite(n) && n > 0) {
      base.flushIntervalSeconds = Math.min(86_400, Math.max(60, n));
    }
  }
  return base;
}
