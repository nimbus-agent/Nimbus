import { parseBool } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

export type NimbusExtensionsToml = {
  updateCheckIntervalHours: number;
  /** `[extensions] trust_check_interval_hours`, [1, 24], default 1 (trust layer). */
  trustCheckIntervalHours: number;
};

export const DEFAULT_NIMBUS_EXTENSIONS_TOML: NimbusExtensionsToml = {
  updateCheckIntervalHours: 24,
  trustCheckIntervalHours: 1,
};

/**
 * The `[extensions] runtime` kill switch's default (extension runtime PR 3): on. `false` refuses
 * every `extension approve` and spawns no approved extension. It is NOT a field of
 * {@link NimbusExtensionsToml}: {@link parseNimbusExtensionsRuntime} is its only parser.
 */
export const DEFAULT_NIMBUS_EXTENSIONS_RUNTIME = true;

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

/** `[extensions] trust_check_interval_hours`: how often the trust feed is fetched (trust layer). */
function parseTrustCheckIntervalHours(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(
      `[extensions].trust_check_interval_hours must be an integer (got: ${valRaw})`,
    );
  }
  if (n < 1 || n > 24) {
    throw new Error(`[extensions].trust_check_interval_hours must be in [1, 24] (got: ${n})`);
  }
  return n;
}

function parseNimbusTomlExtensionsSection(source: string): Partial<NimbusExtensionsToml> {
  const out: Partial<NimbusExtensionsToml> = {};
  forEachSectionEntry(source, "[extensions]", (key, valRaw) => {
    if (key === "update_check_interval_hours") {
      out.updateCheckIntervalHours = parseUpdateCheckIntervalHours(valRaw);
    }
    if (key === "trust_check_interval_hours") {
      out.trustCheckIntervalHours = parseTrustCheckIntervalHours(valRaw);
    }
  });
  return out;
}

/**
 * `[extensions] runtime` read ON ITS OWN. The whole-section loader falls back to every default when
 * `update_check_interval_hours` is invalid (it throws, and `loadTomlSection` swallows that), which
 * would turn a `runtime = false` beside a bad interval back into `true`. The kill switch must not
 * depend on an unrelated key parsing. A malformed value (`runtime = flase`) keeps the default rather
 * than throwing or flipping it. The ONLY parser of the key.
 */
export function parseNimbusExtensionsRuntime(raw: string): boolean {
  let runtime = DEFAULT_NIMBUS_EXTENSIONS_RUNTIME;
  forEachSectionEntry(raw, "[extensions]", (key, valRaw) => {
    if (key !== "runtime") return;
    const b = parseBool(valRaw);
    if (b !== undefined) runtime = b;
  });
  return runtime;
}

export function loadNimbusExtensionsRuntimeFromConfigDir(configDir: string): boolean {
  return loadTomlSectionFromConfig(
    configDir,
    "extensions",
    DEFAULT_NIMBUS_EXTENSIONS_RUNTIME,
    parseNimbusExtensionsRuntime,
  );
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
  return loadTomlSectionFromConfig(
    configDir,
    "extensions",
    DEFAULT_NIMBUS_EXTENSIONS_TOML,
    parseNimbusExtensionsToml,
  );
}
