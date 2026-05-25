/**
 * Pure mapping from an Apache Superset dashboard object to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `superset-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "superset", type = "dashboard"` rows. The `dashboard`
 * type is sparse/structured (title, slug, status), so it stays on local
 * MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 *
 * A Superset dashboard's reliable last-modified timestamp is `changed_on_utc`
 * (ISO-8601). The `changed_by` field is a nested `{ first_name, last_name }`
 * object; we flatten it to a display string.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface SupersetMappingContext {
  /** Superset base URL — used to build canonical dashboard URLs. */
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export interface SupersetMappedRow {
  readonly service: "superset";
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
 * Build the canonical URL for a dashboard. Superset's UI and API share the
 * same host, so there is no host rewrite — the dashboard page lives at
 * `<base>/superset/dashboard/<id>/`.
 */
export function dashboardUrl(baseUrl: string, id: number): string {
  return `${trimTrailingSlash(baseUrl)}/superset/dashboard/${encodeURIComponent(String(id))}/`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Flatten Superset's nested `changed_by` ({ first_name, last_name }) into a
 * single display string, or null when absent / unusable.
 */
function changedByDisplay(raw: unknown): string | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const first = stringField(row, "first_name") ?? "";
  const last = stringField(row, "last_name") ?? "";
  const joined = `${first} ${last}`.trim();
  return joined === "" ? null : joined;
}

/** Count of the `owners` array, or 0 when absent / not an array. */
function ownerCount(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

export function mapSupersetDashboardToItem(
  raw: unknown,
  ctx: SupersetMappingContext,
): SupersetMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = numberField(row, "id");
  if (id === undefined) {
    return null;
  }

  // Title falls back to `Dashboard <id>` when the dashboard_title is missing
  // or empty — a missing title must NOT null the whole row.
  const rawTitle = stringField(row, "dashboard_title");
  const titleField = rawTitle === undefined || rawTitle === "" ? null : rawTitle;
  const title = titleField ?? `Dashboard ${String(id)}`;

  const slug = stringField(row, "slug") ?? null;
  const status = stringField(row, "status") ?? null;
  const published = row["published"] === true;
  const changedAt = parseIsoMs(row["changed_on_utc"]);
  const changedBy = changedByDisplay(row["changed_by"]);

  const canonicalUrl = dashboardUrl(ctx.baseUrl, id);
  const bodyPreview = `${title}${slug !== null && slug !== "" ? ` (${slug})` : ""}`;
  const modifiedAt = changedAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    dashboard_id: id,
    title: titleField,
    slug,
    published,
    status,
    owner_count: ownerCount(row["owners"]),
    changed_by: changedBy,
    changed_at: changedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "superset",
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
