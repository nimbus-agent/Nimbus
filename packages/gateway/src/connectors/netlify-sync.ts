import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { bareArrayPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapNetlifySiteToItem } from "./netlify-site-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "netlify";
const CURSOR_PREFIX = "nimbus-netlify1:";
const BASE = "https://api.netlify.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type NetlifyCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies NetlifyCursorV1);
}

export type NetlifySyncableOptions = {
  ensureNetlifyMcpRunning: () => Promise<void>;
};

interface NetlifyCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<NetlifyCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function sitesPath(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page) });
  return `/api/v1/sites?${params.toString()}`;
}

function netlifyGet(ctx: SyncContext, creds: NetlifyCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

export function createNetlifySyncable(options: NetlifySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureNetlifyMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, page) => netlifyGet(ctx, creds, sitesPath(page)),
        parsePage: (parsed) => bareArrayPage(parsed, PAGE_SIZE),
        map: (raw, _creds, now) => mapNetlifySiteToItem(raw, { syncedAt: now }),
      }),
  };
}
