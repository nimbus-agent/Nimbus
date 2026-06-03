import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface BigqueryMappingContext {
  readonly project: string;
  readonly syncedAt: number;
}

export type BigqueryMappedRow = MappedRow<"bigquery", "table">;

const TITLE_MAX = 256;

const TABLE_TYPES: ReadonlySet<string> = new Set([
  "TABLE",
  "VIEW",
  "EXTERNAL",
  "MATERIALIZED_VIEW",
  "SNAPSHOT",
  "CLONE",
]);

/**
 * BigQuery timestamps in REST responses are epoch-MILLIS strings
 * (e.g. `creationTime: "1700000000000"`). Parse to a finite number, else null.
 */
function parseEpochMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normTableType(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  const upper = raw.toUpperCase();
  return TABLE_TYPES.has(upper) ? upper : raw;
}

/**
 * Extract the schema field names + types only — NO row/cell data. BigQuery nests
 * RECORD fields under `fields`; we flatten one level using dotted paths so the
 * column shape is searchable without storing any values.
 */
export function extractSchemaFields(
  schema: unknown,
  prefix = "",
): Array<{ name: string; type: string }> {
  const rec = asRecord(schema);
  if (rec === undefined) {
    return [];
  }
  const fields = rec["fields"];
  if (!Array.isArray(fields)) {
    return [];
  }
  const out: Array<{ name: string; type: string }> = [];
  for (const f of fields) {
    const fr = asRecord(f);
    if (fr === undefined) {
      continue;
    }
    const name = stringField(fr, "name");
    if (name === undefined || name === "") {
      continue;
    }
    const type = stringField(fr, "type") ?? "";
    const path = prefix === "" ? name : `${prefix}.${name}`;
    out.push({ name: path, type });
    if ((type === "RECORD" || type === "STRUCT") && Array.isArray(fr["fields"])) {
      out.push(...extractSchemaFields(fr, path));
    }
  }
  return out;
}

function clampTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

/**
 * Pure mapper: BigQuery table metadata → IndexedItem. Stores schema field
 * names/types + row COUNTS + byte sizes + timestamps ONLY. A `numRows` integer
 * and `numBytes` are table-level metadata, NOT row data.
 *
 * `raw` may be either a `tables.list` entry or a `tables.get` detail object —
 * both carry `tableReference: { datasetId, tableId }`. Returns null when the
 * table id is missing.
 */
export function mapBigqueryTableToItem(
  raw: unknown,
  ctx: BigqueryMappingContext,
): BigqueryMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const ref = asRecord(row["tableReference"]);
  const datasetId = ref === undefined ? undefined : stringField(ref, "datasetId");
  const tableId = ref === undefined ? undefined : stringField(ref, "tableId");
  if (datasetId === undefined || datasetId === "" || tableId === undefined || tableId === "") {
    return null;
  }

  const tableType = normTableType(stringField(row, "type"));
  const schemaFields = extractSchemaFields(row["schema"]);

  const numRowsRaw = parseEpochMillis(row["numRows"]);
  const numBytesRaw = parseEpochMillis(row["numBytes"]);
  const creationTime = parseEpochMillis(row["creationTime"]);
  const lastModifiedTime = parseEpochMillis(row["lastModifiedTime"]);

  const friendlyName = stringField(row, "friendlyName") ?? null;
  const qualified = `${datasetId}.${tableId}`;
  const title = clampTitle(
    friendlyName !== null && friendlyName !== "" ? `${friendlyName} (${qualified})` : qualified,
  );

  const descriptionRaw = stringField(row, "description") ?? null;
  const fieldSummary =
    schemaFields.length > 0 ? schemaFields.map((f) => `${f.name}:${f.type}`).join(", ") : "";
  const summaryOrQualified = fieldSummary === "" ? qualified : fieldSummary;
  const bodyPreview =
    descriptionRaw === null || descriptionRaw === "" ? summaryOrQualified : descriptionRaw;

  const modifiedAt = lastModifiedTime ?? creationTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    project: ctx.project,
    datasetId,
    tableId,
    tableType,
    schemaFields,
    numRows: numRowsRaw,
    numBytes: numBytesRaw,
    creationTime,
    lastModifiedTime,
    description: descriptionRaw,
  };

  return {
    service: "bigquery",
    type: "table",
    externalId: `${ctx.project}:${qualified}`,
    title,
    bodyPreview: bodyPreview.length > 512 ? `${bodyPreview.slice(0, 512)}…` : bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
