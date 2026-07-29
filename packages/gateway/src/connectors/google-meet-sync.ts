import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import {
  type GoogleMeetParticipant,
  mapGoogleMeetParticipants,
  mapGoogleMeetRecordToItem,
} from "./google-meet-meeting-mapping.ts";
import { fetchGoogleJson } from "./google-sync-shared.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "google_meet";
const CURSOR_PREFIX = "nimbus-gmeet1:";
const PAGE_SIZE = 50;
const BASE = "https://meet.googleapis.com/v2";

/**
 * `conferenceRecords.participants.list` is one extra request per conference
 * record, so the roster is fetched in a SINGLE page and the collection's
 * `totalSize` supplies the true head-count for anything clipped away. A
 * 100-name roster is ~8 KB of metadata, comfortably inside the 64 KB per-item
 * ceiling, and no realistic meeting needs more names than that to be findable.
 *
 * Scope: the same `meetings.space.readonly` already declared for this connector
 * in `connector-catalog.ts` — `participants.list` accepts it, so there is no
 * re-consent.
 */
const PARTICIPANTS_PAGE_SIZE = 100;
const MAX_INDEXED_PARTICIPANTS = 100;

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

interface FetchedParticipants {
  readonly participants: readonly GoogleMeetParticipant[];
  readonly participantCount: number;
  readonly bytes: number;
}

const NO_PARTICIPANTS: FetchedParticipants = {
  participants: [],
  participantCount: 0,
  bytes: 0,
};

/**
 * Fetch one conference record's roster.
 *
 * A participants failure must NOT cost us the conference records themselves —
 * a per-record `403`/`404` (a record the caller can list but not read the roster
 * of) would otherwise abort the whole cycle. Those degrade to an empty roster
 * with a warning. `UnauthenticatedError` (a genuinely dead token) is rethrown so
 * the scheduler still sees the credential failure.
 */
async function fetchParticipants(
  ctx: SyncContext,
  token: string,
  recordName: string,
): Promise<FetchedParticipants> {
  const url = new URL(`${BASE}/${recordName}/participants`);
  url.searchParams.set("pageSize", String(PARTICIPANTS_PAGE_SIZE));
  let json: unknown;
  let bytes: number;
  try {
    ({ json, bytes } = await fetchGoogleJson(ctx, token, url.toString(), "Google Meet", {
      method: "GET",
    }));
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      throw err;
    }
    ctx.logger.warn(
      { serviceId: SERVICE_ID, recordName },
      "Google Meet participants fetch failed; indexing the conference record without a roster",
    );
    return NO_PARTICIPANTS;
  }

  const parsed = asUnknownObjectRecord(json) as { participants?: unknown; totalSize?: unknown };
  const participants = mapGoogleMeetParticipants(parsed.participants, MAX_INDEXED_PARTICIPANTS);
  const totalSize = parsed.totalSize;
  const participantCount =
    typeof totalSize === "number" && Number.isFinite(totalSize) && totalSize >= participants.length
      ? totalSize
      : participants.length;
  return { participants, participantCount, bytes };
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
      let totalBytes = bytes;
      for (const record of records) {
        // `name` is also the mapper's skip rule; guarding on it here means a
        // record the mapper would reject never costs a participants request.
        const recordName = typeof record.name === "string" ? record.name : "";
        const fetched =
          recordName === "" ? NO_PARTICIPANTS : await fetchParticipants(ctx, token, recordName);
        totalBytes += fetched.bytes;
        const mapped = mapGoogleMeetRecordToItem(record, {
          syncedAt: now,
          participants: fetched.participants,
          participantCount: fetched.participantCount,
        });
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
        bytesTransferred: totalBytes,
      };
    },
  };
}
