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
import {
  isTableHeader,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

const DORA_TABLE_PREFIX = "[metrics.dora.";
const SERVICE_CONFIG_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "repos",
  "pagerduty_services",
  "deploy_workflow_pattern",
  "incident_window_minutes",
  "exclude_pr_labels",
  "deploy_environments",
]);

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

/**
 * Resolves a `[<tablePrefix><id>]` table-header line to its `id`, registering an
 * (initially empty) bucket for it in `accum`. Returns `undefined` when `trimmed`
 * does not start with `tablePrefix` at all (a different section's header).
 *
 * Throws on an empty `id` (`[<tablePrefix>]`) — deliberately, for THIS module's two
 * callers (`[metrics.dora.*]` / `[ci.service.*]`), which is why `platform/assemble.ts`
 * wraps `loadNimbusServiceConfigsFromConfigDir` in a try/catch and degrades rather than
 * aborting startup. Exported (pure, already covered by this module's own tests) so
 * `nimbus-toml.ts`'s `[llm.local.<name>]` scan can reuse the same id-resolution logic
 * for its OWN table prefix; that caller has a stricter "never throw" contract (a throw
 * would be swallowed by `loadTomlSection`'s bare catch and silently revert the whole
 * `[llm]` section to defaults, including `enforce_air_gap`), so it wraps this call in
 * its own local try/catch and treats the throw as "skip this one malformed block"
 * rather than letting it propagate.
 */
export function resolveServiceTableId(
  trimmed: string,
  tablePrefix: string,
  blockLabel: string,
  accum: Map<string, Record<string, string>>,
): string | undefined {
  if (!trimmed.startsWith(tablePrefix)) return undefined;
  const id = trimmed.slice(tablePrefix.length, -1);
  if (id.length === 0) throw new Error(`empty service id in [${blockLabel}.<id>]`);
  if (!accum.has(id)) accum.set(id, {});
  return id;
}

function applyServiceConfigLine(
  trimmed: string,
  currentId: string,
  blockLabel: string,
  accum: Map<string, Record<string, string>>,
): void {
  const kv = splitKeyValue(trimmed);
  if (kv === undefined) return;
  if (!SERVICE_CONFIG_KNOWN_KEYS.has(kv.key)) {
    throw new Error(`unknown key '${kv.key}' in [${blockLabel}.${currentId}]`);
  }
  const bucket = accum.get(currentId);
  if (bucket !== undefined) {
    bucket[kv.key] = kv.valRaw;
  }
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
      currentId = resolveServiceTableId(trimmed, tablePrefix, blockLabel, accum);
      continue;
    }
    if (currentId !== undefined) {
      applyServiceConfigLine(trimmed, currentId, blockLabel, accum);
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
