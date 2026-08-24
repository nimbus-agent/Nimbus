import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { type ParsedPage, runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapStripeInvoiceToItem } from "./stripe-invoice-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "stripe";
const CURSOR_PREFIX = "nimbus-stripe1:";
const BASE = "https://api.stripe.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type StripeCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies StripeCursorV1);
}

export type StripeSyncableOptions = {
  ensureStripeMcpRunning: () => Promise<void>;
};

interface StripeCreds {
  readonly apiKey: string;
}

async function loadCreds(ctx: SyncContext): Promise<StripeCreds | null> {
  const apiKey = (await ctx.getSecret("api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

function invoicesPath(startingAfter: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (startingAfter !== null) {
    params.set("starting_after", startingAfter);
  }
  return `/v1/invoices?${params.toString()}`;
}

function stripeGet(ctx: SyncContext, creds: StripeCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
  });
}

function parseStripePage(parsed: unknown): ParsedPage {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const data = root["data"];
  const items: unknown[] = Array.isArray(data) ? data : [];
  const hasMore = root["has_more"] === true;
  if (!hasMore || items.length === 0) {
    return { items, hasMore: false };
  }
  const last = asRecord(items.at(-1));
  const nextId = last === undefined ? "" : (stringField(last, "id") ?? "");
  return { items, hasMore: nextId !== "", nextPageCursor: nextId };
}

export function createStripeSyncable(options: StripeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureStripeMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 1,
        fetchPage: (creds, _page, pageCursor) =>
          stripeGet(ctx, creds, invoicesPath(pageCursor === "" ? null : pageCursor)),
        parsePage: (parsed) => parseStripePage(parsed),
        map: (raw, _creds, now) => mapStripeInvoiceToItem(raw, { syncedAt: now }),
      }),
  };
}
