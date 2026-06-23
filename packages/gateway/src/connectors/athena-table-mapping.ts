import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { BODY_MAX, clamp, parseTimestampMs, TITLE_MAX } from "./warehouse-mapping-primitives.ts";

export interface AthenaMappingContext {
  readonly catalog: string;
  readonly database: string;
  readonly syncedAt: number;
}

export type AthenaMappedRow = MappedRow<"athena", "table">;

/**
 * Extract the column name/type pairs — SCHEMA metadata only, NO row/cell data.
 * Athena column objects carry `{ Name, Type, Comment? }`; we keep name + type.
 */
function extractColumns(raw: unknown): Array<{ name: string; type: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ name: string; type: string }> = [];
  for (const c of raw) {
    const rec = asRecord(c);
    if (rec === undefined) {
      continue;
    }
    const name = stringField(rec, "Name");
    if (name === undefined || name === "") {
      continue;
    }
    out.push({ name, type: stringField(rec, "Type") ?? "" });
  }
  return out;
}

/** Partition keys mirror column shape (name + type). */
function extractPartitionKeys(raw: unknown): Array<{ name: string; type: string }> {
  return extractColumns(raw);
}

/**
 * Pure mapper: Athena table-metadata entry → IndexedItem. Stores table name,
 * type, column names/types, partition keys, parameters, and timestamps ONLY —
 * NO row, cell, or query-result data. Returns null when the table name is
 * missing.
 */
export function mapAthenaTableToItem(
  raw: unknown,
  ctx: AthenaMappingContext,
): AthenaMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const tableName = stringField(row, "Name");
  if (tableName === undefined || tableName === "") {
    return null;
  }

  const tableType = stringField(row, "TableType") ?? null;
  const columns = extractColumns(row["Columns"]);
  const partitionKeys = extractPartitionKeys(row["PartitionKeys"]);
  const parameters = asRecord(row["Parameters"]) ?? null;
  const createTime = parseTimestampMs(row["CreateTime"]);
  const lastAccessTime = parseTimestampMs(row["LastAccessTime"]);

  const qualified = `${ctx.database}.${tableName}`;
  const title = clamp(qualified, TITLE_MAX);

  const columnSummary =
    columns.length > 0 ? columns.map((c) => `${c.name}:${c.type}`).join(", ") : "";
  const bodyPreview = clamp(columnSummary === "" ? qualified : columnSummary, BODY_MAX);

  const modifiedAt = lastAccessTime ?? createTime ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    catalog: ctx.catalog,
    database: ctx.database,
    tableName,
    tableType,
    columns,
    ...(partitionKeys.length > 0 ? { partitionKeys } : {}),
    ...(parameters === null ? {} : { parameters }),
    ...(createTime === null ? {} : { createTime }),
    ...(lastAccessTime === null ? {} : { lastAccessTime }),
  };

  return {
    service: "athena",
    type: "table",
    externalId: `${ctx.catalog}/${qualified}`,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
