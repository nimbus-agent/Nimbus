import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY_RE } from "../teamvault/team-vault-keys.ts";
import { isTableHeader, parseString, splitKeyValue, stripComment } from "./toml-primitives.ts";

export const TEAM_CREDENTIAL_CONNECTORS = [
  "snowflake",
  "tableau",
  "looker",
  "powerbi",
  "montecarlo",
  "bigeye",
] as const;
export type TeamCredentialConnector = (typeof TEAM_CREDENTIAL_CONNECTORS)[number];

export interface ConnectorCredentialConfig {
  readonly credential: "personal" | "team";
  readonly teamEntry?: string;
}

export type ConnectorsConfig = ReadonlyMap<TeamCredentialConnector, ConnectorCredentialConfig>;

const TABLE_PREFIX = "[connectors.";

/** Phase 1: accumulate `[connectors.<name>]` tables into a name → key/value bag map. */
function accumulateConnectorTables(source: string): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let current: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      current =
        trimmed.startsWith(TABLE_PREFIX) && trimmed.endsWith("]")
          ? trimmed.slice(TABLE_PREFIX.length, -1)
          : undefined;
      if (current !== undefined && !accum.has(current)) accum.set(current, {});
      continue;
    }
    if (current === undefined) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    const bag = accum.get(current);
    if (bag !== undefined) bag[kv.key] = parseString(kv.valRaw);
  }
  return accum;
}

/** Phase 2: validate one accumulated table into a typed connector credential config (throws on error). */
function resolveConnectorConfig(
  name: string,
  kv: Record<string, string>,
): ConnectorCredentialConfig {
  if (!(TEAM_CREDENTIAL_CONNECTORS as readonly string[]).includes(name)) {
    throw new Error(
      `connectors.${name} is not a supported team-credential connector (one of: ${TEAM_CREDENTIAL_CONNECTORS.join(", ")})`,
    );
  }
  const credential = kv["credential"] ?? "personal";
  if (credential !== "personal" && credential !== "team") {
    throw new Error(
      `connectors.${name}.credential must be "personal" or "team" (got: ${credential})`,
    );
  }
  if (credential === "personal") {
    return { credential: "personal" };
  }
  const teamEntry = (kv["team_entry"] ?? "").trim();
  if (teamEntry === "") {
    throw new Error(`[connectors.${name}] requires team_entry when credential = "team"`);
  }
  if (!ENTRY_RE.test(teamEntry)) {
    throw new Error(
      `[connectors.${name}] team_entry "${teamEntry}" is invalid (lowercase alphanumerics + dashes, no dots)`,
    );
  }
  return { credential: "team", teamEntry };
}

export function parseNimbusConnectorsToml(source: string): ConnectorsConfig {
  const out = new Map<TeamCredentialConnector, ConnectorCredentialConfig>();
  for (const [name, kv] of accumulateConnectorTables(source)) {
    out.set(name as TeamCredentialConnector, resolveConnectorConfig(name, kv));
  }
  return out;
}

export function loadNimbusConnectorsFromConfigDir(configDir: string): ConnectorsConfig {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return new Map();
  return parseNimbusConnectorsToml(readFileSync(tomlPath, "utf8"));
}
