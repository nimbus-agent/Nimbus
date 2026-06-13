import { normalizeDataModelKey } from "./data-model-key.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type LookerDashboardMappedRow = MappedRow<"looker", "dashboard">;
export type LookerDataModelMappedRow = MappedRow<"looker", "data_model">;

export interface LookerMappingContext {
  readonly syncedAt: number;
}

const SERVICE = "looker" as const;

/**
 * Maps a raw Looker dashboard API object to a dashboard index item.
 * Returns null when the required id or title is missing.
 */
export function mapLookerDashboardToItem(
  raw: unknown,
  ctx: LookerMappingContext,
): LookerDashboardMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const id = stringField(r, "id");
  const title = stringField(r, "title");
  if (id === undefined || id === "" || title === undefined || title === "") return null;
  const folder = stringField(r, "folder") ?? null;
  return {
    service: SERVICE,
    type: "dashboard",
    externalId: `looker:dashboard/${id}`,
    title,
    bodyPreview: "Looker dashboard",
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.syncedAt,
    metadata: { folder, upstreamDataModelKeys: [] },
    syncedAt: ctx.syncedAt,
  };
}

/**
 * Maps a raw Looker LookML view (from the lookml_models API) to a data_model
 * index item.  The `sql_table_name` is normalized via normalizeDataModelKey and
 * stored as both `dataModelKey` and in `derivedFromKeys` — this is the
 * Looker→dbt lineage edge source (a dbt model in GitHub shares the same
 * normalized table key).
 *
 * Returns null when the required model+view identity or sql_table_name (after
 * normalization) is missing.
 */
export function mapLookerViewToItem(
  raw: unknown,
  ctx: LookerMappingContext,
): LookerDataModelMappedRow | null {
  const r = asRecord(raw);
  if (r === undefined) return null;
  const model = stringField(r, "model");
  const name = stringField(r, "name");
  if (model === undefined || model === "" || name === undefined || name === "") return null;
  const sqlTableName = stringField(r, "sql_table_name");
  const dataModelKey = sqlTableName === undefined ? null : normalizeDataModelKey(sqlTableName);
  if (dataModelKey === null) return null;
  const derivedFromKeys = [dataModelKey];
  return {
    service: SERVICE,
    type: "data_model",
    externalId: `looker:view/${model}.${name}`,
    title: `${model}.${name}`,
    bodyPreview: "Looker LookML view",
    url: null,
    canonicalUrl: null,
    modifiedAt: ctx.syncedAt,
    metadata: { dataModelKey, derivedFromKeys },
    syncedAt: ctx.syncedAt,
  };
}
