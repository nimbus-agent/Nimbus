import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { fetchGoogleJson } from "./google-sync-shared.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "google_photos";
const CURSOR_PREFIX = "nimbus-gph1:";
const PAGE_SIZE = 50;

type MediaMetadata = {
  creationTime?: string;
  width?: string;
  height?: string;
};

type MediaItem = {
  id?: string;
  filename?: string;
  mimeType?: string;
  baseUrl?: string;
  productUrl?: string;
  mediaMetadata?: MediaMetadata;
};

type SearchResponse = {
  mediaItems?: MediaItem[];
  nextPageToken?: string;
};

export type GooglePhotosSyncCursorV1 = { v: 1; pageToken: string | null };

export function encodeGooglePhotosSyncCursor(c: GooglePhotosSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

export function decodeGooglePhotosSyncCursor(raw: string): GooglePhotosSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (o == null || typeof o !== "object" || Array.isArray(o)) {
    return undefined;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return undefined;
  }
  const pageToken = r["pageToken"];
  if (pageToken !== null && typeof pageToken !== "string") {
    return undefined;
  }
  return { v: 1, pageToken };
}

function parseSearch(json: unknown): SearchResponse {
  return asUnknownObjectRecord(json);
}

function creationMs(meta: MediaMetadata | undefined, fallback: number): number {
  const raw = meta?.creationTime;
  if (typeof raw !== "string" || raw === "") {
    return fallback;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : fallback;
}

function upsertPhoto(ctx: SyncContext, item: MediaItem, now: number): void {
  const id = item.id;
  if (id === undefined || id === "") {
    return;
  }
  const title =
    typeof item.filename === "string" && item.filename !== "" ? item.filename : `photo_${id}`;
  const url = typeof item.productUrl === "string" ? item.productUrl : null;
  const created = creationMs(item.mediaMetadata, now);
  const meta: Record<string, unknown> = {
    mimeType: item.mimeType,
    baseUrl: item.baseUrl,
    creationTime: item.mediaMetadata?.creationTime,
    width: item.mediaMetadata?.width,
    height: item.mediaMetadata?.height,
  };

  ctx.upsertItem({
    service: SERVICE_ID,
    type: "photo",
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url,
    canonicalUrl: url,
    modifiedAt: created,
    authorId: null,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

function photosSearch(
  ctx: SyncContext,
  token: string,
  pageToken: string | null,
): Promise<{ json: unknown; bytes: number }> {
  const body: Record<string, unknown> = {
    pageSize: PAGE_SIZE,
    filters: { mediaTypeFilter: { mediaTypes: ["ALL_MEDIA"] } },
  };
  if (pageToken !== null && pageToken !== "") {
    body["pageToken"] = pageToken;
  }
  return fetchGoogleJson(
    ctx,
    token,
    "https://photoslibrary.googleapis.com/v1/mediaItems:search",
    "Google Photos",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export type GooglePhotosSyncableOptions = {
  ensureGoogleMcpRunning: () => Promise<void>;
};

export function createGooglePhotosSyncable(options: GooglePhotosSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGoogleMcpRunning();
      const token = await ctx.accessToken();

      let pageToken: string | null;
      if (cursor === null || cursor === "") {
        pageToken = null;
      } else {
        const dec = decodeGooglePhotosSyncCursor(cursor);
        pageToken = dec?.pageToken ?? null;
      }

      const { json, bytes } = await photosSearch(ctx, token, pageToken);
      const parsed = parseSearch(json);
      const items = parsed.mediaItems ?? [];
      const now = Date.now();
      let upserted = 0;
      for (const m of items) {
        upsertPhoto(ctx, m, now);
        upserted += 1;
      }

      const next = parsed.nextPageToken;
      const hasMore = typeof next === "string" && next !== "";
      const nextCursor = hasMore ? encodeGooglePhotosSyncCursor({ v: 1, pageToken: next }) : null;

      return {
        cursor: nextCursor,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bytes,
      };
    },
  };
}
