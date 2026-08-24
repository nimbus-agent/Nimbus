import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { mapHubspotDealToItem } from "./hubspot-deal-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "hubspot";
const CURSOR_PREFIX = "nimbus-hubspot1:";
const BASE = "https://api.hubapi.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DEAL_PROPERTIES =
  "dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate";

type HubspotCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies HubspotCursorV1);
}

export type HubspotSyncableOptions = {
  ensureHubspotMcpRunning: () => Promise<void>;
};

interface HubspotCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<HubspotCreds | null> {
  const raw = await ctx.getSecret("oauth");
  if (raw === null || raw === "") {
    return null;
  }
  let token: string;
  try {
    token = await ctx.accessToken();
  } catch {
    return null;
  }
  return token === "" ? null : { token };
}

function dealsPath(after: string): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    properties: DEAL_PROPERTIES,
  });
  if (after !== "") {
    params.set("after", after);
  }
  return `/crm/v3/objects/deals?${params.toString()}`;
}

function hubspotGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractDeals(parsed: unknown): unknown[] {
  const results = asRecord(parsed)?.["results"];
  return Array.isArray(results) ? results : [];
}

/** HubSpot's cursor: `paging.next.after` is the opaque token for the next page (absent at the end). */
function nextAfter(parsed: unknown): string {
  const next = asRecord(asRecord(parsed)?.["paging"])?.["next"];
  const after = asRecord(next)?.["after"];
  return typeof after === "string" && after !== "" ? after : "";
}

function parseHubspotPage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const deals = extractDeals(parsed);
  const after = nextAfter(parsed);
  return { items: deals, hasMore: deals.length > 0 && after !== "", nextPageCursor: after };
}

export function createHubspotSyncable(options: HubspotSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureHubspotMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          hubspotGet(ctx, creds.token, dealsPath(pageCursor)),
        parsePage: (parsed) => parseHubspotPage(parsed),
        map: (raw, _creds, now) => mapHubspotDealToItem(raw, { syncedAt: now }),
      }),
  };
}
