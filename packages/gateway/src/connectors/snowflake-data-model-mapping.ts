import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type SnowflakeMappedRow = MappedRow<"snowflake", "data_model">;

export interface SnowflakeMappingContext {
  readonly syncedAt: number;
}

const SERVICE = "snowflake" as const;
const TYPE = "data_model" as const;

export function mapSnowflakeTableToItem(
  raw: unknown,
  ctx: SnowflakeMappingContext,
): SnowflakeMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const db = stringField(r, "database_name");
  const schema = stringField(r, "schema_name");
  const table = stringField(r, "table_name");
  if (db === undefined || schema === undefined || table === undefined) return null;
  const key = normalizeDataModelKey(`${db}.${schema}.${table}`);
  if (key === null) return null;
  const rawCols = Array.isArray(r["columns"]) ? r["columns"] : [];
  // Name, type and nullability only (connectors 0.17.2): the schema history diffs these. `ordinal` is
  // display order and is not kept. A column with no name is dropped, and then the set is NOT complete.
  const parsed = rawCols.map((c) => asRecord(c));
  const columns = parsed
    .filter((c): c is Record<string, unknown> => c !== undefined)
    .map((c) => ({
      name: stringField(c, "name") ?? "",
      type: stringField(c, "type") ?? null,
      nullable: typeof c["nullable"] === "boolean" ? c["nullable"] : null,
    }))
    .filter((c) => c.name !== "");
  // Complete only when the connector said so AND every listed column parsed: an older connector (no flag),
  // a failed columns query, a cut list or an unreadable entry all read as incomplete, never as "no columns".
  const columnsComplete = r["columns_complete"] === true && columns.length === rawCols.length;
  const rowCountEstimate = numberField(r, "row_count") ?? null;
  const lastAltered = stringField(r, "last_altered") ?? null;
  const rowCountSummary = rowCountEstimate === null ? "rows unknown" : `~${rowCountEstimate} rows`;
  return {
    service: SERVICE,
    type: TYPE,
    externalId: `snowflake:${key}`,
    title: `${schema}.${table}`,
    bodyPreview: `${columns.length} columns · ${rowCountSummary}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: (() => {
      if (lastAltered === null) return ctx.syncedAt;
      const parsed = Date.parse(lastAltered);
      return Number.isNaN(parsed) ? ctx.syncedAt : parsed;
    })(),
    metadata: { dataModelKey: key, columns, columnsComplete, rowCountEstimate, lastAltered },
    syncedAt: ctx.syncedAt,
  };
}
