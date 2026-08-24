import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { bareArrayPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapZoteroReferenceToItem } from "./zotero-reference-mapping.ts";

const SERVICE_ID = "zotero";
const CURSOR_PREFIX = "nimbus-zotero1:";
const BASE = "https://api.zotero.org";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type ZoteroCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZoteroCursorV1);
}

export type ZoteroSyncableOptions = {
  ensureZoteroMcpRunning: () => Promise<void>;
};

interface ZoteroCreds {
  readonly apiKey: string;
  readonly library: string;
}

async function loadCreds(ctx: SyncContext): Promise<ZoteroCreds | null> {
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  const library = (await ctx.getSecret("library"))?.trim() ?? "";
  if (apiKey === "" || library === "") {
    return null;
  }
  return { apiKey, library };
}

function itemsPath(library: string, start: number): string {
  const params = new URLSearchParams({
    format: "json",
    limit: String(PAGE_SIZE),
    start: String(start),
    sort: "dateModified",
    direction: "desc",
  });
  return `/${library}/items?${params.toString()}`;
}

function zoteroGet(ctx: SyncContext, creds: ZoteroCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: {
      "Zotero-API-Key": creds.apiKey,
      "Zotero-API-Version": "3",
      Accept: "application/json",
    },
  });
}

export function createZoteroSyncable(options: ZoteroSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureZoteroMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, page) =>
          zoteroGet(ctx, creds, itemsPath(creds.library, page * PAGE_SIZE)),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, _creds, now) => mapZoteroReferenceToItem(raw, { syncedAt: now }),
      }),
  };
}
