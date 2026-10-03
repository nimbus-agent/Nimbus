import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface SupersetMappingContext {
  readonly baseUrl: string;
  readonly syncedAt: number;
}

export type SupersetMappedRow = MappedRow<"superset", "dashboard", string>;

export function dashboardUrl(baseUrl: string, id: number): string {
  return `${trimTrailingSlash(baseUrl)}/superset/dashboard/${encodeURIComponent(String(id))}/`;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

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

  const rawTitle = stringField(row, "dashboard_title");
  const titleField = rawTitle === undefined || rawTitle === "" ? null : rawTitle;
  const title = titleField ?? `Dashboard ${String(id)}`;

  const slug = stringField(row, "slug") ?? null;
  const status = stringField(row, "status") ?? null;
  const published = row["published"] === true;
  const changedAt = parseIsoMs(row["changed_on_utc"]);
  const changedBy = changedByDisplay(row["changed_by"]);

  const canonicalUrl = dashboardUrl(ctx.baseUrl, id);
  const slugPart = slug !== null && slug !== "" ? ` (${slug})` : "";
  const bodyPreview = `${title}${slugPart}`;
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
