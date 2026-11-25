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
   * True when the file still says `min_protocol = 1`. The old static-box wire that value kept alive was
   * removed (LAN forward secrecy, slice FS3), so the line is ignored and the boot warns once; the key
   * itself is gone, `2` (the only wire left) is accepted as a no-op and a gateway never fails to start
   * over it.
   */
  minProtocolIgnored: boolean;
};

export const DEFAULT_NIMBUS_LAN_TOML: NimbusLanToml = {
  enabled: false,
  port: 7475,
  bind: "127.0.0.1",
  pairingWindowSeconds: 300,
  maxFailedAttempts: 3,
  lockoutSeconds: 60,
  minProtocolIgnored: false,
};

type LanIntField = "port" | "pairingWindowSeconds" | "maxFailedAttempts" | "lockoutSeconds";

/** The integer keys of `[lan]` and the least value each accepts; a smaller or malformed value is ignored. */
const LAN_INT_KEYS: Readonly<
  Record<string, { readonly field: LanIntField; readonly min: number }>
> = {
  port: { field: "port", min: 1 },
  pairing_window_seconds: { field: "pairingWindowSeconds", min: 1 },
  max_failed_attempts: { field: "maxFailedAttempts", min: 1 },
  lockout_seconds: { field: "lockoutSeconds", min: 0 },
};

function applyNimbusLanKey(out: Partial<NimbusLanToml>, key: string, valRaw: string): void {
  const intKey = Object.hasOwn(LAN_INT_KEYS, key) ? LAN_INT_KEYS[key] : undefined;
  if (intKey !== undefined) {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n >= intKey.min) out[intKey.field] = n;
    return;
  }
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "bind":
      out.bind = parseString(valRaw);
      break;
    case "min_protocol": {
      const n = parseIntDec(valRaw);
      if (n === 1) out.minProtocolIgnored = true;
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
