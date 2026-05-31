import { type AuditLogger, createScopedAuditLogger } from "./audit-logger";
import { type HitlRequest, isHitlRequest } from "./hitl-request";
import type { ExtensionManifest } from "./types";

export class ExtensionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionContractError";
  }
}

const PERMS = new Set<ExtensionManifest["permissions"][number]>(["read", "write", "delete"]);
const HITL = new Set<ExtensionManifest["hitlRequired"][number]>(["write", "delete"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function validateRequiredStrings(manifest: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(manifest.id)) {
    errors.push("manifest.id is required");
  }
  if (!isNonEmptyString(manifest.displayName)) {
    errors.push("manifest.displayName is required");
  }
  if (!isNonEmptyString(manifest.version)) {
    errors.push("manifest.version is required");
  }
  if (!isNonEmptyString(manifest.description)) {
    errors.push("manifest.description is required");
  }
  if (!isNonEmptyString(manifest.author)) {
    errors.push("manifest.author is required");
  }
  if (!isNonEmptyString(manifest.entrypoint)) {
    errors.push("manifest.entrypoint is required");
  }
  return errors;
}

function validateRuntime(manifest: ExtensionManifest): string[] {
  if (manifest.runtime === "bun" || manifest.runtime === "node") {
    return [];
  }
  return ['manifest.runtime must be "bun" or "node"'];
}

function validatePermissions(manifest: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (!Array.isArray(manifest.permissions)) {
    errors.push("manifest.permissions must be an array");
    return errors;
  }
  for (const p of manifest.permissions) {
    if (!PERMS.has(p)) {
      errors.push(`invalid manifest.permissions entry: ${String(p)}`);
    }
  }
  return errors;
}

function validateHitlRequired(manifest: ExtensionManifest): string[] {
  const errors: string[] = [];
  if (Array.isArray(manifest.hitlRequired)) {
    for (const h of manifest.hitlRequired) {
      if (!HITL.has(h)) {
        errors.push(`invalid manifest.hitlRequired entry: ${String(h)}`);
      }
    }
  } else {
    errors.push("manifest.hitlRequired must be an array");
  }
  return errors;
}

function validateMinNimbusVersion(manifest: ExtensionManifest): string[] {
  if (!isNonEmptyString(manifest.minNimbusVersion)) {
    return ["manifest.minNimbusVersion is required"];
  }
  if (!/^\d+\.\d+\.\d+/.test(manifest.minNimbusVersion.trim())) {
    return ["manifest.minNimbusVersion must start with semver x.y.z"];
  }
  return [];
}

function assertV1AuditLoggerShape(logger: AuditLogger, extensionId: string): void {
  const ret = logger.log("test.action", {});
  if (typeof ret.then !== "function") {
    throw new ExtensionContractError(
      `AuditLogger.log must return a Promise (extension ${extensionId})`,
    );
  }
}

function assertV1HitlRequestGuard(): void {
  const good: HitlRequest = { actionId: "x", summary: "y" };
  if (!isHitlRequest(good)) {
    throw new ExtensionContractError("isHitlRequest must accept a valid HitlRequest");
  }
  if (isHitlRequest({})) {
    throw new ExtensionContractError("isHitlRequest must reject an empty object");
  }
  if (isHitlRequest({ actionId: "", summary: "y" })) {
    throw new ExtensionContractError("isHitlRequest must reject empty actionId");
  }
}

/**
 * Tool-name segments that indicate a tool fetches actual ROW / CELL / query-result
 * data (including log EVENTS) — as opposed to schema/metadata. Used by
 * {@link assertNoRowDataTools}.
 *
 * The service prefix of a tool name must be a single token (e.g. `bigquery_list`,
 * not `big_query_list`) so that, for example, `bigquery` never splits into a
 * spurious `query` segment.
 */
export const ROW_DATA_TOOL_SEGMENTS: ReadonlySet<string> = new Set<string>([
  "query",
  "queries",
  "row",
  "rows",
  "cell",
  "cells",
  "record",
  "records",
  "event",
  "events",
  "result",
  "results",
  "tabledata",
  "scan",
  "sample",
  "samples",
  "select",
  "values",
  "preview",
  "head",
  "dump",
  "export",
  "download",
]);

/** A registered MCP tool, reduced to the fields the no-row-data check inspects. */
export interface RowDataToolCandidate {
  readonly name: string;
  readonly description?: string;
}

function toolNameSegments(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/**
 * Tier-3 "no-row-data" contract assertion. A warehouse / logging / query connector
 * must expose ONLY schema/metadata tools (list / get / search over datasets, tables,
 * schemas, jobs, log groups, models, expectation suites …) and MUST NOT register any
 * tool that pulls actual row / cell / query-result data into the local index.
 *
 * Enforcement is structural at the connector surface (NOT a runtime Gateway
 * invariant): if the connector never registers a row/cell tool there is nothing to
 * block at runtime. This assertion is the executable backstop — call it from the
 * connector's contract test with its registered tool surface so that a future edit
 * adding a `<svc>_run_query` / `<svc>_get_rows` / `<svc>_sample` / `<svc>_scan` tool
 * fails CI. A connector that genuinely needs a live-gated row tool is a discrete
 * `I17` design discussion, out of scope for the no-row-data tier.
 *
 * The check is name-based (tool descriptions are not scanned, to avoid false
 * positives like "does not fetch rows"). Each tool name is split on non-alphanumeric
 * boundaries and rejected if any segment is in {@link ROW_DATA_TOOL_SEGMENTS}.
 *
 * @throws {ExtensionContractError} if any tool name looks like a row/cell fetcher.
 */
export function assertNoRowDataTools(
  tools: ReadonlyArray<RowDataToolCandidate>,
  context = "connector",
): void {
  const offenders: string[] = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || tool.name.trim() === "") {
      continue;
    }
    const hit = toolNameSegments(tool.name).find((s) => ROW_DATA_TOOL_SEGMENTS.has(s));
    if (hit !== undefined) {
      offenders.push(`${tool.name} (row-data segment "${hit}")`);
    }
  }
  if (offenders.length > 0) {
    throw new ExtensionContractError(
      `no-row-data contract violated: ${context} must expose only schema/metadata tools, ` +
        `but these look like row/cell/result fetchers: ${offenders.join(", ")}. Remove the ` +
        `tool, or — if a live-gated row tool is genuinely required — raise it as a discrete ` +
        `I17 design discussion (out of scope for the no-row-data tier).`,
    );
  }
}

/**
 * Validates a {@link ExtensionManifest} for CI / `nimbus test` (no network, no Gateway).
 */
export async function runContractTests(manifest: ExtensionManifest): Promise<void> {
  const errors: string[] = [
    ...validateRequiredStrings(manifest),
    ...validateRuntime(manifest),
    ...validatePermissions(manifest),
    ...validateHitlRequired(manifest),
    ...validateMinNimbusVersion(manifest),
  ];
  if (errors.length > 0) {
    throw new ExtensionContractError(errors.join("; "));
  }
  assertV1HitlRequestGuard();
  assertV1AuditLoggerShape(
    createScopedAuditLogger(manifest.id, async () => {}),
    manifest.id,
  );
}
