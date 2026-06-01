import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Tier-3 no-row-data reader for Great Expectations validation-result JSON
 * artefacts. This module is the MCP-server-side counterpart of the gateway's
 * pure `mapGreatExpectationsResultToItem` mapper: BOTH strip the failing-data
 * SAMPLE lists so no real data cell value ever leaves the artefact dir.
 *
 * GX validation-result `result` objects carry aggregate metrics (observed_value
 * scalar, element_count, unexpected_count, unexpected_percent) AND, for failing
 * expectations, sampled rows of the actual unexpected DATA in:
 *   - unexpected_list
 *   - partial_unexpected_list
 *   - partial_unexpected_index_list
 *   - unexpected_index_list
 *   - partial_unexpected_counts
 * Those carry real data cell values (row data) and MUST NEVER be read into a
 * tool result. We copy ONLY the aggregate scalars; if observed_value is itself
 * an array/object of sampled values, it is DROPPED.
 */

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // skip artefacts larger than ~4 MiB
const MAX_WALK_DEPTH = 12;

/** Sample/row-data keys that MUST never be copied out of a GX `result` object. */
export const FORBIDDEN_RESULT_KEYS: ReadonlySet<string> = new Set([
  "unexpected_list",
  "partial_unexpected_list",
  "partial_unexpected_index_list",
  "unexpected_index_list",
  "partial_unexpected_counts",
]);

export interface GxExpectationMeta {
  readonly suiteName: string;
  readonly batchId: string;
  readonly runId: string | null;
  readonly runTime: string | null;
  readonly expectationType: string;
  readonly column: string | null;
  readonly success: boolean;
  /** Aggregate scalar only — never an array/object of sampled values. */
  readonly observedValue: number | string | boolean | null;
  readonly elementCount: number | null;
  readonly unexpectedCount: number | null;
  readonly unexpectedPercent: number | null;
  readonly successPercent: number | null;
  /** Stable composite id: `<suite>::<batch>::<expectationType>::<column ?? "_">`. */
  readonly externalId: string;
  /** Source artefact path (relative to the results dir). */
  readonly sourceFile: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string | null {
  const v = r[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function numField(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pull the aggregate observed value ONLY when it is a scalar (number / string /
 * boolean). Some expectations (e.g. distinct-value checks) return an array or
 * object of sampled values for observed_value — those are DROPPED (null) so no
 * row data leaks.
 */
function scalarObservedValue(result: Record<string, unknown>): number | string | boolean | null {
  const v = result["observed_value"];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  return null;
}

function deriveRunId(meta: Record<string, unknown>): string | null {
  const runId = meta["run_id"];
  if (typeof runId === "string" && runId !== "") {
    return runId;
  }
  if (isRecord(runId)) {
    return strField(runId, "run_name") ?? strField(runId, "run_time");
  }
  return null;
}

function deriveRunTime(meta: Record<string, unknown>): string | null {
  const runId = meta["run_id"];
  if (isRecord(runId)) {
    const rt = strField(runId, "run_time");
    if (rt !== null) {
      return rt;
    }
  }
  return strField(meta, "run_time") ?? strField(meta, "validation_time");
}

function deriveBatchId(meta: Record<string, unknown>): string {
  const direct = strField(meta, "batch_id") ?? strField(meta, "active_batch_definition_id") ?? null;
  if (direct !== null) {
    return direct;
  }
  const def = meta["active_batch_definition"];
  if (isRecord(def)) {
    const name =
      strField(def, "batch_identifiers") ??
      strField(def, "data_asset_name") ??
      strField(def, "datasource_name");
    if (name !== null) {
      return name;
    }
  }
  const spec = meta["batch_spec"];
  if (isRecord(spec)) {
    const p = strField(spec, "path") ?? strField(spec, "table_name");
    if (p !== null) {
      return p;
    }
  }
  return "_";
}

function clampId(id: string): string {
  // Keep composite external ids bounded; hash-suffix when overly long.
  if (id.length <= 256) {
    return id;
  }
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return `${id.slice(0, 240)}#${(h >>> 0).toString(16)}`;
}

/**
 * Parse one GX validation-result JSON document into per-expectation metadata
 * rows — METADATA / AGGREGATES ONLY. The forbidden sample lists are never read.
 */
export function parseValidationResult(parsed: unknown, sourceFile: string): GxExpectationMeta[] {
  const root = isRecord(parsed) ? parsed : undefined;
  if (root === undefined) {
    return [];
  }
  const meta = isRecord(root["meta"]) ? root["meta"] : {};
  const suiteName = strField(meta, "expectation_suite_name") ?? "_";
  const batchId = deriveBatchId(meta);
  const runId = deriveRunId(meta);
  const runTime = deriveRunTime(meta);

  const statistics = isRecord(root["statistics"]) ? root["statistics"] : {};
  const successPercent = numField(statistics, "success_percent");

  const results = Array.isArray(root["results"]) ? root["results"] : [];
  const out: GxExpectationMeta[] = [];
  for (const entry of results) {
    if (!isRecord(entry)) {
      continue;
    }
    const config = isRecord(entry["expectation_config"]) ? entry["expectation_config"] : {};
    const expectationType = strField(config, "expectation_type") ?? "unknown";
    const kwargs = isRecord(config["kwargs"]) ? config["kwargs"] : {};
    const column = strField(kwargs, "column");
    const success = entry["success"] === true;

    const result = isRecord(entry["result"]) ? entry["result"] : {};
    const observedValue = scalarObservedValue(result);
    const elementCount = numField(result, "element_count");
    const unexpectedCount = numField(result, "unexpected_count");
    const unexpectedPercent = numField(result, "unexpected_percent");

    const externalId = clampId(`${suiteName}::${batchId}::${expectationType}::${column ?? "_"}`);

    out.push({
      suiteName,
      batchId,
      runId,
      runTime,
      expectationType,
      column,
      success,
      observedValue,
      elementCount,
      unexpectedCount,
      unexpectedPercent,
      successPercent,
      externalId,
      sourceFile,
    });
  }
  return out;
}

/**
 * Resolve the configured GX results dir from the environment. Throws when unset
 * so the MCP tools surface a clear error rather than reading an empty path.
 */
export function resultsDir(): string {
  const dir = process.env["GREAT_EXPECTATIONS_RESULTS_DIR"]?.trim();
  if (dir === undefined || dir === "") {
    throw new Error("GREAT_EXPECTATIONS_RESULTS_DIR is not set");
  }
  return resolve(dir);
}

/**
 * Path-traversal guard: confirm `candidate` (an absolute resolved path) is the
 * results dir itself or a descendant of it. Rejects `..`-escaping inputs. This
 * is the filesystem analog of the argv flag-smuggling guard.
 */
export function assertWithinResultsDir(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    return; // the dir itself
  }
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path escapes the configured Great Expectations results dir");
  }
}

/** Recursively collect `*.json` artefact paths under `root` (bounded). */
async function collectJsonFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_FILES) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function readArtefact(path: string): Promise<unknown | null> {
  try {
    // Read first (no check-then-use race): readFile throws on a directory or a
    // missing file, and the buffer length bounds the size — no stat-gated read.
    const buf = await readFile(path);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return null;
    }
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read all GX validation-result artefacts under the configured results dir and
 * return the flattened per-expectation METADATA rows. Bad / oversized /
 * unparseable artefacts are skipped. NEVER reads any sample list.
 */
export async function listAllExpectations(): Promise<GxExpectationMeta[]> {
  const root = resultsDir();
  const files = await collectJsonFiles(root);
  const out: GxExpectationMeta[] = [];
  for (const file of files) {
    assertWithinResultsDir(file, root);
    const parsed = await readArtefact(file);
    if (parsed === null) {
      continue;
    }
    out.push(...parseValidationResult(parsed, relative(root, file)));
  }
  return out;
}
