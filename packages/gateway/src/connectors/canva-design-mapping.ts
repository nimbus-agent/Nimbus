import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export interface CanvaMappingContext {
  readonly syncedAt: number;
}

export type CanvaMappedRow = MappedRow<"canva", "design">;

/**
 * Canva Connect design timestamps (`created_at`, `updated_at`) are Unix epoch
 * SECONDS (e.g. 1735776000). Convert to epoch-milliseconds. Tolerate an ISO-8601
 * string encoding defensively. Returns null when unrecognizable.
 */
function parseCanvaTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Epoch seconds → milliseconds.
    return Math.trunc(v * 1000);
  }
  if (typeof v === "string" && v !== "") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function deriveTitle(title: string | null, id: string): string {
  return title !== null && title !== "" ? title : `Canva design ${id}`;
}

export function mapCanvaDesignToItem(
  raw: unknown,
  ctx: CanvaMappingContext,
): CanvaMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const title = stringField(row, "title") ?? null;
  const createdAt = parseCanvaTimestampMs(row["created_at"]);
  const updated = parseCanvaTimestampMs(row["updated_at"]);

  const urls = asRecord(row["urls"]) ?? {};
  const editUrl = stringField(urls, "edit_url") ?? null;
  const viewUrl = stringField(urls, "view_url") ?? null;

  const thumbnail = asRecord(row["thumbnail"]) ?? {};
  const thumbnailUrl = stringField(thumbnail, "url") ?? null;

  const modifiedAt = updated ?? createdAt ?? ctx.syncedAt;
  const canonical = viewUrl ?? editUrl;

  const displayTitle = deriveTitle(title, id);

  const metadata: Record<string, unknown> = {
    id,
    title,
    created_at: createdAt,
    updated_at: updated,
    edit_url: editUrl,
    view_url: viewUrl,
    thumbnail_url: thumbnailUrl,
  };

  return {
    service: "canva",
    type: "design",
    externalId: id,
    title: displayTitle,
    bodyPreview: displayTitle,
    url: canonical,
    canonicalUrl: canonical,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
