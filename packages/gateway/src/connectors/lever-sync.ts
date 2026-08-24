import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapLeverPostingToItem } from "./lever-posting-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "lever";
const CURSOR_PREFIX = "nimbus-lever1:";
const BASE = "https://api.lever.co";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type LeverCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LeverCursorV1);
}

export type LeverSyncableOptions = {
  ensureLeverMcpRunning: () => Promise<void>;
};

interface LeverCreds {
  readonly apiKey: string;
}

async function loadCreds(ctx: SyncContext): Promise<LeverCreds | null> {
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function basicAuthHeader(apiKey: string): string {
  const b64 = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function postingsPath(offset: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset !== null) {
    params.set("offset", offset);
  }
  return `/v1/postings?${params.toString()}`;
}

function leverGet(ctx: SyncContext, creds: LeverCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: basicAuthHeader(creds.apiKey), Accept: "application/json" },
  });
}

function parseLeverPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false, nextPageCursor: "" };
  }
  const data = root["data"];
  const postings = Array.isArray(data) ? data : [];
  const nextRaw = stringField(root, "next") ?? null;
  const next = nextRaw === "" ? null : nextRaw;
  const hasNext = root["hasNext"] === true;
  return {
    items: postings,
    hasMore: hasNext && next !== null,
    nextPageCursor: next ?? "",
  };
}

export function createLeverSyncable(options: LeverSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureLeverMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, _page, pageCursor) =>
          leverGet(ctx, creds, postingsPath(pageCursor === "" ? null : pageCursor)),
        parsePage: (parsed) => parseLeverPage(parsed),
        map: (raw, _creds, now) => mapLeverPostingToItem(raw, { syncedAt: now }),
      }),
  };
}
