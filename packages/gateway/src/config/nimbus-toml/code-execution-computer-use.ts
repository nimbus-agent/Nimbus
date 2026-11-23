import { parseBool, parseIntDec, parseString, parseStringArray } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

/**
 * Runtime ids this build can actually execute. Config naming an unknown id drops it, rather than
 * carrying a name no registry can resolve all the way to a spawn attempt.
 */
export const KNOWN_EXEC_RUNTIMES = ["bun"] as const;

export type NimbusCodeExecutionToml = {
  enabled: boolean;
  maxWallClockMs: number;
  maxOutputBytes: number;
  allowedRuntimes: string[];
};

/**
 * DEFAULT OFF. With `enabled = false` the exec gate refuses before it ever reaches consent, so a
 * fresh install has no arbitrary-code-execution path at all and the capability's existence cannot
 * be probed by triggering a consent prompt.
 */
export const DEFAULT_NIMBUS_CODE_EXECUTION_TOML: NimbusCodeExecutionToml = {
  enabled: false,
  maxWallClockMs: 30_000,
  maxOutputBytes: 1_048_576,
  allowedRuntimes: ["bun"],
};

/**
 * Normalise to lowercase and drop unknown ids.
 *
 * The lowercasing is load-bearing, not cosmetic: the exec gate compares this array against the
 * runtime registry's own lowercase id, so if this stopped normalising, `allowed_runtimes = ["Bun"]`
 * would silently refuse every execution.
 */
function parseAllowedRuntimes(valRaw: string): string[] {
  const known = new Set<string>(KNOWN_EXEC_RUNTIMES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of parseStringArray(valRaw)) {
    const id = v.trim().toLowerCase();
    if (id === "" || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyNimbusCodeExecutionKey(
  out: Partial<NimbusCodeExecutionToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "max_wall_clock_ms": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxWallClockMs = n;
      break;
    }
    case "max_output_bytes": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxOutputBytes = n;
      break;
    }
    case "allowed_runtimes":
      out.allowedRuntimes = parseAllowedRuntimes(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlCodeExecutionSection(source: string): Partial<NimbusCodeExecutionToml> {
  const out: Partial<NimbusCodeExecutionToml> = {};
  forEachSectionEntry(source, "[code_execution]", (key, valRaw) => {
    applyNimbusCodeExecutionKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusCodeExecutionToml(
  raw: string,
  defaults: NimbusCodeExecutionToml = DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
): NimbusCodeExecutionToml {
  return { ...defaults, ...parseNimbusTomlCodeExecutionSection(raw) };
}

export function loadNimbusCodeExecutionFromPath(tomlPath: string): NimbusCodeExecutionToml {
  return loadTomlSection(
    tomlPath,
    DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
    parseNimbusCodeExecutionToml,
  );
}

export function loadNimbusCodeExecutionFromConfigDir(configDir: string): NimbusCodeExecutionToml {
  return loadTomlSectionFromConfig(
    configDir,
    "code_execution",
    DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
    parseNimbusCodeExecutionToml,
  );
}

export const KNOWN_CU_LANES = ["browser", "terminal", "screen"] as const;
export type CuLane = (typeof KNOWN_CU_LANES)[number];

export type NimbusComputerUseToml = {
  enabled: boolean;
  allowedLanes: CuLane[];
  maxActions: number;
  maxWallClockMs: number;
  browserProfileDir: string;
  snapshotMaxBytes: number;
  snapshotRetentionDays: number;
};

/**
 * DEFAULT OFF, and `allowedLanes` DEFAULT EMPTY — a deliberate SECOND lock, and a departure from
 * `[code_execution]`'s non-empty `allowed_runtimes = ["bun"]`. `enabled = true` on its own actuates
 * nothing; the operator must name each lane. The screen lane costs `nimbus prove` its verdict for
 * any window containing one action, so opting into a lane should be an act rather than something
 * inherited from flipping one boolean.
 */
export const DEFAULT_NIMBUS_COMPUTER_USE_TOML: NimbusComputerUseToml = {
  enabled: false,
  allowedLanes: [],
  maxActions: 50,
  maxWallClockMs: 300_000,
  browserProfileDir: "",
  snapshotMaxBytes: 262_144,
  snapshotRetentionDays: 7,
};

/**
 * Normalise to lowercase and drop unknown lanes. The lowercasing is load-bearing: the gate compares
 * this array against the lane literal, so if this stopped normalising, `allowed_lanes = ["Browser"]`
 * would silently refuse every session with a message about the lane not being allowed.
 */
function parseAllowedLanes(valRaw: string): CuLane[] {
  const known = new Set<string>(KNOWN_CU_LANES);
  const seen = new Set<string>();
  const out: CuLane[] = [];
  for (const v of parseStringArray(valRaw)) {
    const id = v.trim().toLowerCase();
    if (id === "" || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id as CuLane);
  }
  return out;
}

function applyNimbusComputerUseKey(
  out: Partial<NimbusComputerUseToml>,
  key: string,
  valRaw: string,
): void {
  const positive = (assign: (n: number) => void): void => {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) assign(n);
  };
  switch (key) {
    case "enabled":
      out.enabled = valRaw.trim().toLowerCase() === "true";
      break;
    case "allowed_lanes":
      out.allowedLanes = parseAllowedLanes(valRaw);
      break;
    case "max_actions":
      positive((n) => {
        out.maxActions = n;
      });
      break;
    case "max_wall_clock_ms":
      positive((n) => {
        out.maxWallClockMs = n;
      });
      break;
    case "browser_profile_dir":
      out.browserProfileDir = parseString(valRaw);
      break;
    case "snapshot_max_bytes":
      positive((n) => {
        out.snapshotMaxBytes = n;
      });
      break;
    case "snapshot_retention_days":
      positive((n) => {
        out.snapshotRetentionDays = n;
      });
      break;
    default:
      break;
  }
}

export function parseNimbusComputerUseToml(
  raw: string,
  defaults: NimbusComputerUseToml = DEFAULT_NIMBUS_COMPUTER_USE_TOML,
): NimbusComputerUseToml {
  const out: Partial<NimbusComputerUseToml> = {};
  forEachSectionEntry(raw, "[computer_use]", (key, valRaw) => {
    applyNimbusComputerUseKey(out, key, valRaw);
  });
  return { ...defaults, ...out };
}

export function loadNimbusComputerUseFromConfigDir(configDir: string): NimbusComputerUseToml {
  return loadTomlSectionFromConfig(
    configDir,
    "computer_use",
    DEFAULT_NIMBUS_COMPUTER_USE_TOML,
    parseNimbusComputerUseToml,
  );
}
