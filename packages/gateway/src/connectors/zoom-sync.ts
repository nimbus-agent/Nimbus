import { getValidZoomAccessToken } from "../auth/zoom-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";
import { mapZoomMeetingToItem } from "./zoom-meeting-mapping.ts";

const SERVICE_ID = "zoom";
const CURSOR_PREFIX = "nimbus-zoom1:";
const BASE = "https://api.zoom.us";
const PAGE_SIZE = 100;
// MAX_PAGES * PAGE_SIZE = 2 000 meetings/cycle. Matches every other Tier-1
// connector's cap; the median Zoom user has well under that. Heavy users
// (years of recurring meetings) would see truncation here — raising the cap
// is a deliberate follow-up paired with cursor-persistence across cycles,
// not a v1 change.
const MAX_PAGES = 20;

type ZoomCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZoomCursorV1);
}

export type ZoomSyncableOptions = {
  ensureZoomMcpRunning: () => Promise<void>;
};

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

function meetingsPath(pageToken: string): string {
  const params = new URLSearchParams({
    type: "scheduled",
    page_size: String(PAGE_SIZE),
  });
  if (pageToken !== "") {
    params.set("next_page_token", pageToken);
  }
  return `/v2/users/me/meetings?${params.toString()}`;
}

async function zoomGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Bearer auth — the token is never logged. Path-only logging on error.
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "zoom GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractPage(parsed: unknown): { meetings: unknown[]; nextPageToken: string } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { meetings: [], nextPageToken: "" };
  }
  const meetings = root["meetings"];
  const nextRaw = root["next_page_token"];
  return {
    meetings: Array.isArray(meetings) ? meetings : [],
    nextPageToken: typeof nextRaw === "string" ? nextRaw : "",
  };
}

function upsertMeetings(ctx: SyncContext, meetings: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const m of meetings) {
    const mapped = mapZoomMeetingToItem(m, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

/**
 * Walk A only — `GET /v2/users/me/meetings?type=scheduled&page_size=100`,
 * following `next_page_token`, capped at MAX_PAGES. Walk B (recordings +
 * transcripts) is PR-3. The first-page http/parse error path maps to the
 * pass-cursor-empty result so a transient Zoom outage doesn't lose the
 * cursor; later-page errors break and keep whatever was already upserted.
 */
export function createZoomSyncable(options: ZoomSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureZoomMcpRunning();

      const raw = await readConnectorSecret(ctx.vault, "zoom", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await getValidZoomAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let pageToken = "";

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await zoomGet(ctx, token, meetingsPath(pageToken));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { meetings, nextPageToken } = extractPage(outcome.parsed);
        totalUpserted += upsertMeetings(ctx, meetings, now);

        if (meetings.length === 0 || nextPageToken === "") {
          break;
        }
        pageToken = nextPageToken;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
