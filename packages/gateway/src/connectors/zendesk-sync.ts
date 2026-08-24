import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { mapZendeskTicketToItem } from "./zendesk-ticket-mapping.ts";

const SERVICE_ID = "zendesk";
const CURSOR_PREFIX = "nimbus-zendesk1:";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type ZendeskCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies ZendeskCursorV1);
}

export type ZendeskSyncableOptions = {
  ensureZendeskMcpRunning: () => Promise<void>;
};

interface ZendeskCreds {
  readonly url: string;
  readonly email: string;
  readonly apiToken: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function zendeskBasicAuthHeader(email: string, apiToken: string): string {
  const cred = `${email}/token:${apiToken}`;
  const b64 = Buffer.from(cred, "utf8").toString("base64");
  return `Basic ${b64}`;
}

async function loadCreds(ctx: SyncContext): Promise<ZendeskCreds | null> {
  const url = (await ctx.getSecret("url"))?.trim() ?? "";
  const email = (await ctx.getSecret("email"))?.trim() ?? "";
  const apiToken = (await ctx.getSecret("api_token"))?.trim() ?? "";
  if (url === "" || email === "" || apiToken === "") {
    return null;
  }
  return { url: trimTrailingSlash(url), email, apiToken };
}

function ticketsPath(afterCursor: string | null): string {
  const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE) });
  if (afterCursor !== null && afterCursor !== "") {
    params.set("page[after]", afterCursor);
  }
  return `/api/v2/tickets.json?${params.toString()}`;
}

function zendeskGet(ctx: SyncContext, creds: ZendeskCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.url}${path}`, {
    headers: {
      Authorization: zendeskBasicAuthHeader(creds.email, creds.apiToken),
      Accept: "application/json",
    },
  });
}

function parseZendeskPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const root = asRecord(parsed);
  const ticketsRaw = root?.["tickets"];
  const tickets = Array.isArray(ticketsRaw) ? ticketsRaw : [];
  const meta = asRecord(root?.["meta"]) ?? {};
  const hasMore = meta["has_more"] === true;
  const afterCursor = stringField(meta, "after_cursor") ?? null;
  return {
    items: tickets,
    hasMore: hasMore && afterCursor !== null && afterCursor !== "",
    nextPageCursor: afterCursor ?? "",
  };
}

export function createZendeskSyncable(options: ZendeskSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureZendeskMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          zendeskGet(ctx, creds, ticketsPath(pageCursor === "" ? null : pageCursor)),
        parsePage: (parsed) => parseZendeskPage(parsed),
        map: (raw, creds, now) =>
          mapZendeskTicketToItem(raw, { baseUrl: creds.url, syncedAt: now }),
      }),
  };
}
