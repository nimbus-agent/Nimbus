import { getValidHubspotAccessToken } from "../auth/hubspot-access-token.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
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

function upsertDeals(ctx: SyncContext, deals: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const d of deals) {
    const mapped = mapHubspotDealToItem(d, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createHubspotSyncable(options: HubspotSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureHubspotMcpRunning();

      const raw = await readConnectorSecret(ctx.vault, "hubspot", "oauth");
      if (raw === null || raw === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await getValidHubspotAccessToken(ctx.vault);
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      // Cursor pagination: `paging.next.after` is the opaque token to the next
      // page (or absent at the end). Walk a single forward pass per cycle,
      // page-capped.
      let after = "";
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await hubspotGet(ctx, token, dealsPath(after));
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
        const deals = extractDeals(outcome.parsed);
        totalUpserted += upsertDeals(ctx, deals, now);
        after = nextAfter(outcome.parsed);
        if (deals.length === 0 || after === "") {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
