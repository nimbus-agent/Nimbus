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
  const columns = rawCols
    .map((c) => asRecord(c))
    .filter((c): c is Record<string, unknown> => c !== undefined)
    .map((c) => ({ name: stringField(c, "name") ?? "", tag: stringField(c, "tag") ?? null }))
    .filter((c) => c.name !== "");
  const rowCountEstimate = numberField(r, "row_count") ?? null;
  const lastAltered = stringField(r, "last_altered") ?? null;
  return {
    service: SERVICE,
    type: TYPE,
    externalId: `snowflake:${key}`,
    title: `${schema}.${table}`,
    bodyPreview: `${columns.length} columns · ${rowCountEstimate === null ? "rows unknown" : `~${rowCountEstimate} rows`}`,
    url: null,
    canonicalUrl: null,
    modifiedAt: lastAltered !== null ? Date.parse(lastAltered) || ctx.syncedAt : ctx.syncedAt,
    metadata: { dataModelKey: key, columns, rowCountEstimate, lastAltered },
    syncedAt: ctx.syncedAt,
  };
}
