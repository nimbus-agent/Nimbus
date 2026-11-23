import { processEnvGet } from "../../platform/env-access.ts";
import { parseBool, parseIntDec, parseString } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

export type NimbusLanToml = {
  enabled: boolean;
  port: number;
  bind: string;
  pairingWindowSeconds: number;
  maxFailedAttempts: number;
  lockoutSeconds: number;
  /**
   * The lowest LAN wire protocol this gateway accepts and uses (LAN forward secrecy). `1` is the old
   * static-box wire, accepted for a peer that has not completed a v2 session; `2` refuses it for
   * every peer. Default 1 until the compatibility window closes (OR-FS-1).
   */
  minProtocol: 1 | 2;
};

export const DEFAULT_NIMBUS_LAN_TOML: NimbusLanToml = {
  enabled: false,
  port: 7475,
  bind: "127.0.0.1",
  pairingWindowSeconds: 300,
  maxFailedAttempts: 3,
  lockoutSeconds: 60,
  minProtocol: 1,
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
    case "min_protocol": {
      const n = parseIntDec(valRaw);
      if (n === 1 || n === 2) out.minProtocol = n;
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
  // The fallback goes through `parseNimbusLanToml` too, so `NIMBUS_LAN_PORT` applies whether or
  // not a config file exists (as the updater loader does). With the bare defaults it was ignored
  // with no file yet honoured on a pack-only render, the same install answering two ways.
  return loadTomlSection(tomlPath, parseNimbusLanToml(""), parseNimbusLanToml);
}

export function loadNimbusLanFromConfigDir(configDir: string): NimbusLanToml {
  return loadTomlSectionFromConfig(configDir, "lan", parseNimbusLanToml(""), parseNimbusLanToml);
}
