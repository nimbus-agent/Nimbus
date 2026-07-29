import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapReadwiseBookToItem } from "./readwise-book-mapping.ts";
import { mapReadwiseHighlightToItem } from "./readwise-highlight-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "readwise";
const CURSOR_PREFIX = "nimbus-readwise1:";
const BASE = "https://readwise.io";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

type ReadwiseCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ReadwiseCursorV1);
}

export type ReadwiseSyncableOptions = {
  ensureReadwiseMcpRunning: () => Promise<void>;
};

interface ReadwiseCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<ReadwiseCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "readwise", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function highlightsPath(page: number): string {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page: String(page) });
  return `/api/v2/highlights/?${params.toString()}`;
}

function booksPath(page: number): string {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE), page: String(page) });
  return `/api/v2/books/?${params.toString()}`;
}

function readwiseGet(ctx: SyncContext, creds: ReadwiseCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" },
  });
}

/**
 * The Django-REST-Framework page envelope. `/api/v2/highlights/` and
 * `/api/v2/books/` both use it, so both walks share this parser.
 */
function parseReadwisePage(parsed: unknown): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const results = root["results"];
  const items = Array.isArray(results) ? results : [];
  const nextRaw = root["next"];
  const next = typeof nextRaw === "string" && nextRaw !== "" ? nextRaw : null;
  return { items, hasMore: items.length > 0 && next !== null };
}

/**
 * Two independent single-pass walks over the same credential: highlights
 * (`readwise:highlight`) then books (`readwise:book`). They are separate DRF
 * list endpoints with no ordering dependency, so a failure in one degrades that
 * walk only — {@link runSinglePassPaginatedSync} already turns a first-page
 * error into an empty pass-cursor result and a later-page error into a break.
 *
 * `ensureRunning` / `loadCreds` are resolved ONCE here rather than once per
 * walk, so the unconfigured case still returns the exact `syncNoopResult` (no
 * MCP spawn, no HTTP) it did when this connector indexed highlights only.
 */
export function createReadwiseSyncable(options: ReadwiseSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureReadwiseMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }
      const alreadyRunning = async (): Promise<void> => {};
      const alreadyLoaded = async (): Promise<ReadwiseCreds> => creds;

      const highlights = await runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: alreadyRunning,
        loadCreds: alreadyLoaded,
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (c, page) => readwiseGet(ctx, c, highlightsPath(page)),
        parsePage: (parsed) => parseReadwisePage(parsed),
        map: (raw, _c, now) => mapReadwiseHighlightToItem(raw, { syncedAt: now }),
      });

      const books = await runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: alreadyRunning,
        loadCreds: alreadyLoaded,
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (c, page) => readwiseGet(ctx, c, booksPath(page)),
        parsePage: (parsed) => parseReadwisePage(parsed),
        map: (raw, _c, now) => mapReadwiseBookToItem(raw, { syncedAt: now }),
      });

      return {
        ...highlights,
        itemsUpserted: highlights.itemsUpserted + books.itemsUpserted,
        bytesTransferred: (highlights.bytesTransferred ?? 0) + (books.bytesTransferred ?? 0),
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
