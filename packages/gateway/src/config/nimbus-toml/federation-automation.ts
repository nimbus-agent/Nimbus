import { parseBool, parseIntDec, parseString } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

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
  return loadTomlSectionFromConfig(
    configDir,
    "federation",
    DEFAULT_NIMBUS_FEDERATION_TOML,
    parseNimbusFederationToml,
  );
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
  return loadTomlSectionFromConfig(
    configDir,
    "automation",
    DEFAULT_NIMBUS_AUTOMATION_TOML,
    parseNimbusAutomationToml,
  );
}
