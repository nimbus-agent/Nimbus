import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { type ParsedPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
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

function parseRaindropPage(parsed: unknown): ParsedPage {
  const root = asRecord(parsed);
  const items =
    root !== undefined && Array.isArray(root["items"]) ? (root["items"] as unknown[]) : [];
  return { items, hasMore: items.length >= PER_PAGE };
}

export function createRaindropSyncable(options: RaindropSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureRaindropMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, page) => raindropGet(ctx, creds, raindropsPath(page)),
        parsePage: (parsed) => parseRaindropPage(parsed),
        map: (raw, _creds, now) => mapRaindropBookmarkToItem(raw, { syncedAt: now }),
      }),
  };
}
