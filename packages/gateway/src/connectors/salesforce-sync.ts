import { getValidSalesforceAuth } from "../auth/salesforce-access-token.ts";
import type { Syncable, SyncContext } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync } from "./_lib/paginated-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSalesforceOpportunityToItem } from "./salesforce-opportunity-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "salesforce";
const CURSOR_PREFIX = "nimbus-salesforce1:";
const API_VERSION = "v60.0";
const PAGE_LIMIT = 200;
// Defensive per-cycle cap. SOQL responses page via nextRecordsUrl; this bounds a
// runaway org with tens of thousands of opportunities.
const MAX_PAGES = 20;
const OPPORTUNITY_FIELDS =
  "Id, Name, StageName, Amount, CloseDate, Probability, Type, IsClosed, IsWon, LastModifiedDate, CreatedDate";

type SalesforceCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies SalesforceCursorV1);
}

export type SalesforceSyncableOptions = {
  ensureSalesforceMcpRunning: () => Promise<void>;
};

interface SalesforceCreds {
  readonly accessToken: string;
  readonly instanceUrl: string;
}

async function loadCreds(ctx: SyncContext): Promise<SalesforceCreds | null> {
  const raw = await ctx.getSecret("oauth");
  if (raw === null || raw === "") {
    return null;
  }
  let accessToken: string;
  let instanceUrl: string;
  try {
    const auth = await getValidSalesforceAuth(
      () => ctx.accessToken(),
      () => ctx.getSecret("oauth"),
    );
    accessToken = auth.accessToken;
    instanceUrl = auth.instanceUrl;
  } catch {
    return null;
  }
  if (accessToken === "" || instanceUrl === "") {
    return null;
  }
  return { accessToken, instanceUrl };
}

function firstQueryPath(): string {
  const soql = `SELECT ${OPPORTUNITY_FIELDS} FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT ${String(PAGE_LIMIT)}`;
  return `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}

function salesforceGet(
  ctx: SyncContext,
  instanceUrl: string,
  token: string,
  path: string,
): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${instanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractRecords(parsed: unknown): unknown[] {
  const records = asRecord(parsed)?.["records"];
  return Array.isArray(records) ? records : [];
}

/**
 * SOQL query pagination: when `done` is false a `nextRecordsUrl` (an absolute
 * instance-relative path, e.g. `/services/data/v60.0/query/01g...-2000`) points
 * at the next page. Return "" to stop.
 */
function nextRecordsPath(parsed: unknown): string {
  const root = asRecord(parsed);
  if (root === undefined || root["done"] === true) {
    return "";
  }
  const next = stringField(root, "nextRecordsUrl");
  return next !== undefined && next !== "" ? next : "";
}

function parseSalesforcePage(parsed: unknown): {
  items: unknown[];
  hasMore: boolean;
  nextPageCursor: string;
} {
  const records = extractRecords(parsed);
  const next = nextRecordsPath(parsed);
  return { items: records, hasMore: records.length > 0 && next !== "", nextPageCursor: next };
}

export function createSalesforceSyncable(options: SalesforceSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) =>
      runSinglePassPaginatedSync(ctx, cursor, {
        ensureRunning: options.ensureSalesforceMcpRunning,
        loadCreds: () => loadCreds(ctx),
        pass1Cursor,
        maxPages: MAX_PAGES,
        startPage: 0,
        fetchPage: (creds, _page, pageCursor) =>
          salesforceGet(
            ctx,
            creds.instanceUrl,
            creds.accessToken,
            pageCursor === "" ? firstQueryPath() : pageCursor,
          ),
        parsePage: (parsed) => parseSalesforcePage(parsed),
        map: (raw, _creds, now) => mapSalesforceOpportunityToItem(raw, { syncedAt: now }),
      }),
  };
}
