import { getValidSalesforceAuth } from "../auth/salesforce-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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

function upsertOpportunities(ctx: SyncContext, records: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const r of records) {
    const mapped = mapSalesforceOpportunityToItem(r, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createSalesforceSyncable(options: SalesforceSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSalesforceMcpRunning();

      const raw = await readConnectorSecret(ctx.vault, "salesforce", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let accessToken: string;
      let instanceUrl: string;
      try {
        const auth = await getValidSalesforceAuth(ctx.vault);
        accessToken = auth.accessToken;
        instanceUrl = auth.instanceUrl;
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (accessToken === "" || instanceUrl === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      // SOQL query pagination: walk a single forward pass per cycle following
      // `nextRecordsUrl`, page-capped.
      let path = firstQueryPath();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await salesforceGet(ctx, instanceUrl, accessToken, path);
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          // Mid-walk error: keep what we already upserted, stop without throwing.
          break;
        }
        const records = extractRecords(outcome.parsed);
        totalUpserted += upsertOpportunities(ctx, records, now);
        const next = nextRecordsPath(outcome.parsed);
        if (records.length === 0 || next === "") {
          break;
        }
        path = next;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
