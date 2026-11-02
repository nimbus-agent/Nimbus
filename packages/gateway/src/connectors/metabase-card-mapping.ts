import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import {
  collectionIdKey,
  type MetabaseMappingContext,
  parseIsoMs,
} from "./metabase-dashboard-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type MetabaseCardMappedRow = MappedRow<"metabase", "card", string>;

export function cardUrl(baseUrl: string, id: number): string {
  return `${trimTrailingSlash(baseUrl)}/question/${encodeURIComponent(String(id))}`;
}

/**
 * The saved SQL of a native question, or null for any other question. v0.65.2 returns MBQL 5
 * (`stages[0].native`); older versions return `native.query`. `template-tags` sit beside the SQL
 * in both shapes and are left behind, because their defaults can hold real filter values.
 */
function nativeSql(row: Record<string, unknown>): string | null {
  const query = asRecord(row["dataset_query"]);
  if (query === undefined) {
    return null;
  }
  const stages = query["stages"];
  const sql = Array.isArray(stages)
    ? asRecord(stages[0])?.["native"]
    : asRecord(query["native"])?.["query"];
  return typeof sql === "string" && sql !== "" ? sql : null;
}

/**
 * Copies a listed set of fields and never spreads the record: `result_metadata` (data-derived
 * fingerprints), `visualization_settings` and `parameters` must not reach the index.
 */
export function mapMetabaseCardToItem(
  raw: unknown,
  ctx: MetabaseMappingContext,
): MetabaseCardMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = numberField(row, "id");
  if (id === undefined) {
    return null;
  }

  const name = stringField(row, "name");
  if (name === undefined || name === "") {
    return null;
  }

  const description = stringField(row, "description") ?? null;
  const collectionKey = collectionIdKey(row["collection_id"]);
  const collectionName =
    collectionKey === null ? null : (ctx.collectionNames[collectionKey] ?? null);
  const createdAtMs = parseIsoMs(row["created_at"]);
  const updatedAtMs = parseIsoMs(row["updated_at"]);
  const sql = nativeSql(row);

  const canonicalUrl = cardUrl(ctx.baseUrl, id);

  const metadata: Record<string, unknown> = {
    card_id: id,
    name,
    description,
    card_type: stringField(row, "type") ?? null,
    collection_id: collectionKey,
    collection_name: collectionName,
    dashboard_id: numberField(row, "dashboard_id") ?? null,
    creator_id: numberField(row, "creator_id") ?? null,
    archived: row["archived"] === true,
    query_type: stringField(row, "query_type") ?? null,
    database_id: numberField(row, "database_id") ?? null,
    table_id: numberField(row, "table_id") ?? null,
    native_query: sql?.slice(0, BODY_MAX_PROSE) ?? null,
    native_query_truncated: sql !== null && sql.length > BODY_MAX_PROSE,
    created_at: createdAtMs,
    updated_at: updatedAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "metabase",
    type: "card",
    externalId: `card/${String(id)}`,
    title: name,
    bodyPreview: description === null || description === "" ? name : description,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: updatedAtMs ?? createdAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
