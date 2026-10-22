import { existsSync, readFileSync } from "node:fs";
import {
  fallbackMessage,
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";

export type NimbusSessionToml = {
  memoryTtlHours: number;
};

export const DEFAULT_NIMBUS_SESSION_TOML: NimbusSessionToml = {
  memoryTtlHours: 24,
};

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
}

function applySessionTomlKey(out: Partial<NimbusSessionToml>, trimmed: string): void {
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return;
  }
  const key = trimmed.slice(0, eq).trim();
  const valRaw = trimmed.slice(eq + 1).trim();
  if (key !== "memory_ttl_hours") {
    return;
  }
  const n = Number.parseInt(valRaw, 10);
  if (Number.isFinite(n) && n > 0 && n <= 24 * 365) {
    out.memoryTtlHours = n;
  }
}

export function parseNimbusTomlSessionSection(source: string): Partial<NimbusSessionToml> {
  const lines = source.split(/\r?\n/);
  let inSession = false;
  const out: Partial<NimbusSessionToml> = {};

  for (const line of lines) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSession = trimmed === "[session]";
      continue;
    }
    if (inSession) {
      applySessionTomlKey(out, trimmed);
    }
  }
  return out;
}

export function loadNimbusSessionFromPath(tomlPath: string): NimbusSessionToml {
  let raw: string | null;
  try {
    raw = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  } catch {
    return { ...DEFAULT_NIMBUS_SESSION_TOML };
  }
  return loadNimbusSessionFromText(raw);
}

/** The one `[session]` core: defaults on no file or a parse error. */
function loadNimbusSessionFromText(
  raw: string | null,
  onFallback?: SectionFallbackSink,
): NimbusSessionToml {
  if (raw === null) {
    return { ...DEFAULT_NIMBUS_SESSION_TOML };
  }
  try {
    return { ...DEFAULT_NIMBUS_SESSION_TOML, ...parseNimbusTomlSessionSection(raw) };
  } catch (err) {
    onFallback?.(fallbackMessage(err));
    return { ...DEFAULT_NIMBUS_SESSION_TOML };
  }
}

export function loadNimbusSessionFromConfigDir(configDir: string): NimbusSessionToml {
  return loadNimbusSessionFromText(
    layeredConfigText(configDir),
    sectionFallbackSink(configDir, "session"),
  );
}
