import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapRaindropBookmarkToItem } from "./raindrop-bookmark-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "raindrop";
const CURSOR_PREFIX = "nimbus-raindrop1:";
const BASE = "https://api.raindrop.io";
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

async function loadCreds(ctx: SyncContext): Promise<RaindropCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "raindrop", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function raindropsPath(page: number): string {
  const params = new URLSearchParams({ perpage: String(PER_PAGE), page: String(page) });
  return `/rest/v1/raindrops/0?${params.toString()}`;
}

function raindropGet(ctx: SyncContext, creds: RaindropCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

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
