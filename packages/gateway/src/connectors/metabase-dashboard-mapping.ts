import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MetabaseMappingContext {
  readonly baseUrl: string;
  readonly collectionNames: Record<string, string>;
  readonly syncedAt: number;
}

export type MetabaseMappedRow = MappedRow<"metabase", "dashboard", string>;

export function dashboardUrl(baseUrl: string, id: number): string {
  return `${trimTrailingSlash(baseUrl)}/dashboard/${encodeURIComponent(String(id))}`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function collectionIdKey(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string" && raw !== "") {
    return raw;
  }
  return null;
}

function cardCount(row: Record<string, unknown>): number | null {
  const dashcards = row["dashcards"];
  if (Array.isArray(dashcards)) {
    return dashcards.length;
  }
  const cards = row["cards"];
  if (Array.isArray(cards)) {
    return cards.length;
  }
  return null;
}

export function mapMetabaseDashboardToItem(
  raw: unknown,
  ctx: MetabaseMappingContext,
): MetabaseMappedRow | null {
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
  const creatorId = numberField(row, "creator_id") ?? null;
  const createdAtMs = parseIsoMs(row["created_at"]);
  const updatedAtMs = parseIsoMs(row["updated_at"]);

  const canonicalUrl = dashboardUrl(ctx.baseUrl, id);
  const title = name;
  const bodyPreview = description ?? name;
  const modifiedAt = updatedAtMs ?? createdAtMs ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    dashboard_id: id,
    name,
    description,
    collection_id: collectionKey,
    collection_name: collectionName,
    creator_id: creatorId,
    archived: row["archived"] === true,
    card_count: cardCount(row),
    created_at: createdAtMs,
    updated_at: updatedAtMs,
    canonical_url: canonicalUrl,
  };

  return {
    service: "metabase",
    type: "dashboard",
    externalId: String(id),
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
