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
import { mapRampTransactionToItem } from "./ramp-transaction-mapping.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "ramp";
const CURSOR_PREFIX = "nimbus-ramp1:";
const BASE = "https://api.ramp.com";
const TOKEN_PATH = "/developer/v1/token";
const TRANSACTIONS_PATH = "/developer/v1/transactions?page_size=100";
const TOKEN_SCOPE = "transactions:read";
const MAX_PAGES = 20;

type RampCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies RampCursorV1);
}

export type RampSyncableOptions = {
  ensureRampMcpRunning: () => Promise<void>;
};

interface RampCreds {
  readonly clientId: string;
  readonly clientSecret: string;
}

async function loadCreds(ctx: SyncContext): Promise<RampCreds | null> {
  const clientId = (await readConnectorSecret(ctx.vault, "ramp", "client_id"))?.trim() ?? "";
  const clientSecret =
    (await readConnectorSecret(ctx.vault, "ramp", "client_secret"))?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return null;
  }
  return { clientId, clientSecret };
}

async function exchangeToken(
  ctx: SyncContext,
  creds: RampCreds,
): Promise<{ token: string | null; bytes: number }> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: TOKEN_SCOPE,
  });
  const outcome = await connectorFetch(ctx, SERVICE_ID, `${BASE}${TOKEN_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (outcome.kind === "http_error") {
    return { token: null, bytes: outcome.bytes };
  }
  if (outcome.kind === "parse_error") {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "ramp token exchange returned invalid JSON");
    return { token: null, bytes: outcome.bytes };
  }
  const parsed = outcome.parsed as { access_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "ramp token exchange returned no access_token");
    return { token: null, bytes: outcome.bytes };
  }
  return { token: parsed.access_token, bytes: outcome.bytes };
}

function rampGet(ctx: SyncContext, token: string, url: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function extractTransactions(parsed: unknown): unknown[] {
  const data = asRecord(parsed)?.["data"];
  return Array.isArray(data) ? data : [];
}

function nextPageUrl(parsed: unknown): string | null {
  const page = asRecord(asRecord(parsed)?.["page"]);
  const next = page?.["next"];
  return typeof next === "string" && next !== "" ? next : null;
}

function upsertTransactions(
  ctx: SyncContext,
  transactions: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const t of transactions) {
    const mapped = mapRampTransactionToItem(t, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createRampSyncable(options: RampSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureRampMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const auth = await exchangeToken(ctx, creds);
      let totalBytes = auth.bytes;
      let token = auth.token;
      if (token === null) {
        return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      let reExchanged = false;
      // Cursor pagination: `page.next` is a full URL to the next page (or null
      // at the end). Walk a single forward pass per cycle, page-capped.
      let url: string | null = `${BASE}${TRANSACTIONS_PATH}`;
      for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
        let outcome = await rampGet(ctx, token, url);
        totalBytes += outcome.bytes;

        // On a 401 the access token may have expired mid-cycle — re-exchange
        // once, then retry the same page.
        if (outcome.kind === "http_error" && outcome.status === 401 && !reExchanged) {
          reExchanged = true;
          const refreshed = await exchangeToken(ctx, creds);
          totalBytes += refreshed.bytes;
          if (refreshed.token === null) {
            if (page === 0) {
              return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
            }
            break;
          }
          token = refreshed.token;
          outcome = await rampGet(ctx, token, url);
          totalBytes += outcome.bytes;
        }

        if (outcome.kind !== "ok") {
          if (page === 0) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const transactions = extractTransactions(outcome.parsed);
        totalUpserted += upsertTransactions(ctx, transactions, now);
        url = nextPageUrl(outcome.parsed);
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
