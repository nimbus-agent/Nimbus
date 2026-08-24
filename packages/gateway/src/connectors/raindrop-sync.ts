import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { type ParsedPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapRaindropBookmarkToItem } from "./raindrop-bookmark-mapping.ts";
import { mapRaindropCollectionToItem } from "./raindrop-collection-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "raindrop";
const CURSOR_PREFIX = "nimbus-raindrop1:";
const BASE = "https://api.raindrop.io";
const PER_PAGE = 50;
const MAX_PAGES = 20;

/**
 * The two collection-list endpoints. Neither is paginated — each returns every
 * matching collection in one `{ result, items: [...] }` response — so each is
 * walked with `maxPages: 1`. `/collections` returns the root collections;
 * `/collections/childrens` returns every nested one (the only shape difference
 * is the `parent.$id` a child carries).
 */
const ROOT_COLLECTIONS_PATH = "/rest/v1/collections";
const CHILD_COLLECTIONS_PATH = "/rest/v1/collections/childrens";

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
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
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

/** `{ result, items, count }` → the items array (empty when absent/malformed). */
function raindropItems(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  return root !== undefined && Array.isArray(root["items"]) ? (root["items"] as unknown[]) : [];
}

function parseRaindropPage(parsed: unknown): ParsedPage {
  const items = raindropItems(parsed);
  return { items, hasMore: items.length >= PER_PAGE };
}

/**
 * `SyncResult.bytesTransferred` is optional on the shared type, but every
 * terminal result {@link runSinglePassPaginatedSync} can return populates it —
 * its one un-populated path (`syncNoopResult`) is unreachable here because
 * `sync()` returns early when the credential is missing. The `?? 0` is a
 * type-level guard, not a live branch.
 */
function bytesOf(result: SyncResult): number {
  return result.bytesTransferred ?? 0;
}

/**
 * Two independent single-pass walks over the same credential: bookmarks
 * (`raindrop:bookmark`, page-number paginated) then collections
 * (`raindrop:collection`, one unpaginated call per endpoint). They are separate
 * endpoints with no ordering dependency, so a failure in one degrades that walk
 * only — {@link runSinglePassPaginatedSync} already turns a first-page error
 * into an empty pass-cursor result.
 *
 * `ensureRunning` / `loadCreds` are resolved ONCE in `sync()` rather than once
 * per walk, so the unconfigured case still returns the exact `syncNoopResult`
 * (no MCP spawn, no HTTP) it did when this connector indexed bookmarks only.
 */
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
      const alreadyRunning = async (): Promise<void> => {};
      const alreadyLoaded = async (): Promise<RaindropCreds> => creds;

      const bookmarks = await runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: alreadyRunning,
        loadCreds: alreadyLoaded,
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (c, page) => raindropGet(ctx, c, raindropsPath(page)),
        parsePage: (parsed) => parseRaindropPage(parsed),
        map: (raw, _c, now) => mapRaindropBookmarkToItem(raw, { syncedAt: now }),
      });

      const walkCollections = (path: string): Promise<SyncResult> =>
        runSinglePassPaginatedSync(ctx, cursor, {
          ensureRunning: alreadyRunning,
          loadCreds: alreadyLoaded,
          pass1Cursor,
          // Unpaginated: one request returns every collection for this endpoint.
          maxPages: 1,
          startPage: 0,
          fetchPage: (c) => raindropGet(ctx, c, path),
          parsePage: (parsed) => ({ items: raindropItems(parsed), hasMore: false }),
          map: (raw, _c, now) => mapRaindropCollectionToItem(raw, { syncedAt: now }),
        });

      const rootCollections = await walkCollections(ROOT_COLLECTIONS_PATH);
      const childCollections = await walkCollections(CHILD_COLLECTIONS_PATH);

      return {
        ...bookmarks,
        itemsUpserted:
          bookmarks.itemsUpserted + rootCollections.itemsUpserted + childCollections.itemsUpserted,
        bytesTransferred: bytesOf(bookmarks) + bytesOf(rootCollections) + bytesOf(childCollections),
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
