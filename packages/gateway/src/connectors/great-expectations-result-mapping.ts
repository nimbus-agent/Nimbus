import { clampSyncTitle } from "../sync/pass-cursor-sync-result.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type GreatExpectationsMappedRow = MappedRow<"great_expectations", "data_quality_test">;

/**
 * Failing-data SAMPLE keys in a GX `result` object. These carry real data cell
 * values (row data) and MUST NEVER be read into the index. The pure mapper here
 * is the no-row-data stripping boundary: it copies ONLY the aggregate scalar
 * metrics and never touches any of these keys.
 */
export const GX_FORBIDDEN_RESULT_KEYS: ReadonlySet<string> = new Set([
  "unexpected_list",
  "partial_unexpected_list",
  "partial_unexpected_index_list",
  "unexpected_index_list",
  "partial_unexpected_counts",
]);

export interface GreatExpectationsMappingContext {
  readonly suiteName: string;
  readonly batchId: string;
  readonly runId: string | null;
  readonly runTime: string | null;
  readonly successPercent: number | null;
  readonly syncedAt: number;
  /** Fallback timestamp when run time is unparseable (e.g. artefact mtime). */
  readonly fileModifiedAt: number | null;
}

const ID_MAX = 256;

/**
 * RFC3339 / ISO-8601 timestamp → epoch ms, else null. Mirrors the other
 * connectors' local `parseIsoMs`.
 */
function parseIsoMs(v: string | null): number | null {
  if (v === null || v.trim() === "") {
    return null;
  }
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the observed value ONLY when it is a scalar (number / string /
 * boolean). Some expectations return an array/object of sampled values for
 * `observed_value` — those are real data cells and are DROPPED (null).
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

function clampExternalId(id: string): string {
  if (id.length <= ID_MAX) {
    return id;
  }
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return `${id.slice(0, ID_MAX - 16)}#${(h >>> 0).toString(16)}`;
}

/**
 * Pure mapper: ONE GX `results[]` entry → a `data_quality_test` IndexedItem.
 *
 * This is the no-row-data stripping site. From the entry's `result` object it
 * copies ONLY the aggregate scalar fields (`observed_value` when scalar,
 * `element_count`, `unexpected_count`, `unexpected_percent`). It NEVER reads
 * `unexpected_list` / `partial_unexpected_list` / `partial_unexpected_index_list`
 * / `unexpected_index_list` / `partial_unexpected_counts` — those carry real
 * data cell values. Returns null when the expectation type is missing.
 */
export function mapGreatExpectationsResultToItem(
  resultEntry: unknown,
  ctx: GreatExpectationsMappingContext,
): GreatExpectationsMappedRow | null {
  const entry = asRecord(resultEntry);
  if (entry === undefined) {
    return null;
  }

  const config = asRecord(entry["expectation_config"]) ?? {};
  const expectationType = stringField(config, "expectation_type");
  if (expectationType === undefined || expectationType === "") {
    return null;
  }
  const kwargs = asRecord(config["kwargs"]) ?? {};
  const column = stringField(kwargs, "column") ?? null;
  const success = entry["success"] === true;

  const result = asRecord(entry["result"]) ?? {};
  const observedValue = scalarObservedValue(result);
  const elementCount = numberField(result, "element_count") ?? null;
  const unexpectedCount = numberField(result, "unexpected_count") ?? null;
  const unexpectedPercent = numberField(result, "unexpected_percent") ?? null;

  const externalId = clampExternalId(
    `${ctx.suiteName}::${ctx.batchId}::${expectationType}::${column ?? "_"}`,
  );

  const columnSuffix = column === null ? "" : column;
  const title = clampSyncTitle(`${ctx.suiteName} · ${expectationType}(${columnSuffix})`);

  const outcome = success ? "passed" : "failed";
  const bodyPreview = clampSyncTitle(
    `${expectationType} on ${column ?? "(table)"} — ${outcome}` +
      (observedValue === null ? "" : `; observed=${String(observedValue)}`),
  );

  const modifiedAt = parseIsoMs(ctx.runTime) ?? ctx.fileModifiedAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    suiteName: ctx.suiteName,
    batchId: ctx.batchId,
    runId: ctx.runId,
    expectationType,
    column,
    success,
    observedValue,
    elementCount,
    unexpectedCount,
    unexpectedPercent,
    successPercent: ctx.successPercent,
    runTime: ctx.runTime,
  };

  return {
    service: "great_expectations",
    type: "data_quality_test",
    externalId,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
