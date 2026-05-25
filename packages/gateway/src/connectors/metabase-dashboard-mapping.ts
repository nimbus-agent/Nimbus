/**
 * Pure mapping from a Metabase dashboard object to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `metabase-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "metabase", type = "dashboard"` rows. The `dashboard`
 * type is sparse/structured (name, collection, short description), so it
 * stays on local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * The dashboard's collection name is resolved by the syncable from a single
 * `/api/collection` call and passed in via `ctx.collectionNames`. Metabase
 * collection ids can be numbers OR the string `"root"`; we key the map by
 * `String(collection_id)`.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MetabaseMappingContext {
  /** Metabase base URL — used to build canonical dashboard URLs. */
  readonly baseUrl: string;
  /** Map of `String(collection_id)` → collection name, resolved from `/api/collection`. */
  readonly collectionNames: Record<string, string>;
  readonly syncedAt: number;
}

export interface MetabaseMappedRow {
  readonly service: "metabase";
  readonly type: "dashboard";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Build the canonical URL for a dashboard. Metabase's UI and API share the
 * same host, so there is no host rewrite — the dashboard page lives at
 * `<base>/dashboard/<id>`.
 */
export function dashboardUrl(baseUrl: string, id: number): string {
  return `${trimTrailingSlash(baseUrl)}/dashboard/${encodeURIComponent(String(id))}`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Normalise a Metabase `collection_id` (number, the string `"root"`, or
 * null/undefined) into a stable string key, or null when absent.
 */
function collectionIdKey(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string" && raw !== "") {
    return raw;
  }
  return null;
}

/** Count the dashcards/cards array if present; null when neither is an array. */
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
