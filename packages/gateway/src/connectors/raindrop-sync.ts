import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapRaindropBookmarkToItem } from "./raindrop-bookmark-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "raindrop";
const CURSOR_PREFIX = "nimbus-raindrop1:";
const BASE = "https://api.raindrop.io";
// Raindrop's `perpage` max is 50; a short page signals the last page.
const PER_PAGE = 50;
const MAX_PAGES = 20;

type RaindropCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies RaindropCursorV1);
}

export type RaindropSyncableOptions = {
  ensureRaindropMcpRunning: () => Promise<void>;
};

interface RaindropCreds {
  readonly token: string;
}

/**
 * `raindrop.token` is required. Raindrop's API host is a fixed SaaS host
 * (`api.raindrop.io`) — there is no host override key. The connector no-ops
 * unless the token is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<RaindropCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "raindrop", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/** Build `/rest/v1/raindrops/0?perpage=50&page=N` (collection id `0` = all raindrops). */
function raindropsPath(page: number): string {
  const params = new URLSearchParams({ perpage: String(PER_PAGE), page: String(page) });
  return `/rest/v1/raindrops/0?${params.toString()}`;
}

async function raindropGet(
  ctx: SyncContext,
  creds: RaindropCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Raindrop uses Bearer auth: `Authorization: Bearer <token>` (a Raindrop.io
  // test token or OAuth access token; the token is never logged).
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "raindrop GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /rest/v1/raindrops/0` returns the Raindrop envelope
 * `{ result, items: [...], count }`. Extract the `items` array defensively — a
 * missing/malformed envelope yields an empty page so the walk terminates.
 */
function extractBookmarks(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  if (root === undefined) {
    return [];
  }
  const items = root["items"];
  return Array.isArray(items) ? items : [];
}

function upsertBookmarks(ctx: SyncContext, bookmarks: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const b of bookmarks) {
    const mapped = mapRaindropBookmarkToItem(b, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createRaindropSyncable(options: RaindropSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureRaindropMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // The bookmarks walk is the gating call: a FIRST-page http/parse error
      // maps to the pass-cursor-empty result. Later-page errors just break,
      // preserving whatever was already collected. Raindrop page-paginates by
      // PAGE NUMBER, 0-based: start at `page=0`; stop when a page is empty OR a
      // short page (fewer than `perpage` items signals the last page), or when
      // the MAX_PAGES cap stops the walk.
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await raindropGet(ctx, creds, raindropsPath(page));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const bookmarks = extractBookmarks(outcome.parsed);
        totalUpserted += upsertBookmarks(ctx, bookmarks, now);

        if (bookmarks.length === 0 || bookmarks.length < PER_PAGE) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
