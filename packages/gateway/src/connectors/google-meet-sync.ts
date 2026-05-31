import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { mapGoogleMeetRecordToItem } from "./google-meet-meeting-mapping.ts";
import { fetchGoogleJson } from "./google-sync-shared.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "google_meet";
const CURSOR_PREFIX = "nimbus-gmeet1:";
const PAGE_SIZE = 50;
const BASE = "https://meet.googleapis.com/v2";

type ConferenceRecord = {
  name?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
  space?: string;
};

type ListResponse = {
  conferenceRecords?: ConferenceRecord[];
  nextPageToken?: string;
};

export type GoogleMeetSyncCursorV1 = { v: 1; pageToken: string | null };

export function encodeGoogleMeetSyncCursor(c: GoogleMeetSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

export function decodeGoogleMeetSyncCursor(raw: string): GoogleMeetSyncCursorV1 | undefined {
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

function parseList(json: unknown): ListResponse {
  return asUnknownObjectRecord(json);
}

function conferenceRecordsList(
  ctx: SyncContext,
  token: string,
  pageToken: string | null,
): Promise<{ json: unknown; bytes: number }> {
  const url = new URL(`${BASE}/conferenceRecords`);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  if (pageToken !== null && pageToken !== "") {
    url.searchParams.set("pageToken", pageToken);
  }
  return fetchGoogleJson(ctx, token, url.toString(), "Google Meet", { method: "GET" });
}

export type GoogleMeetSyncableOptions = {
  ensureGoogleMcpRunning: () => Promise<void>;
};

export function createGoogleMeetSyncable(options: GoogleMeetSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 6 * 60 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureGoogleMcpRunning();
      const token = await getValidGoogleAccessToken(ctx.vault, "google_meet");

      let pageToken: string | null;
      if (cursor === null || cursor === "") {
        pageToken = null;
      } else {
        const dec = decodeGoogleMeetSyncCursor(cursor);
        pageToken = dec?.pageToken ?? null;
      }

      const { json, bytes } = await conferenceRecordsList(ctx, token, pageToken);
      const parsed = parseList(json);
      const records = parsed.conferenceRecords ?? [];
      const now = Date.now();
      let upserted = 0;
      for (const record of records) {
        const mapped = mapGoogleMeetRecordToItem(record, { syncedAt: now });
        if (mapped === null) {
          continue;
        }
        upsertIndexedItemForSync(ctx, mapped);
        upserted += 1;
      }

      const next = parsed.nextPageToken;
      const hasMore = typeof next === "string" && next !== "";
      const nextCursor = hasMore ? encodeGoogleMeetSyncCursor({ v: 1, pageToken: next }) : null;

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
