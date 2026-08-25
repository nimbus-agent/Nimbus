import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
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
  const clientId = (await ctx.getSecret("client_id"))?.trim() ?? "";
  const clientSecret = (await ctx.getSecret("client_secret"))?.trim() ?? "";
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
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

interface PageWalkState {
  token: string;
  bytes: number;
  reExchanged: boolean;
}

interface PageFetchResult {
  readonly outcome: FetchOutcome;
  /** Set when a mid-cycle re-exchange failed to mint a fresh token. */
  readonly reExchangeFailed: boolean;
}

/**
 * Fetch one transactions page, re-exchanging the access token ONCE on a 401
 * (the token may have expired mid-cycle) and retrying the same page. Mutates the
 * byte/token/re-exchange counters on `state`.
 */
async function fetchTransactionsPage(
  ctx: SyncContext,
  creds: RampCreds,
  url: string,
  state: PageWalkState,
): Promise<PageFetchResult> {
  let outcome = await rampGet(ctx, state.token, url);
  state.bytes += outcome.bytes;

  if (outcome.kind === "http_error" && outcome.status === 401 && !state.reExchanged) {
    state.reExchanged = true;
    const refreshed = await exchangeToken(ctx, creds);
    state.bytes += refreshed.bytes;
    if (refreshed.token === null) {
      return { outcome, reExchangeFailed: true };
    }
    state.token = refreshed.token;
    outcome = await rampGet(ctx, state.token, url);
    state.bytes += outcome.bytes;
  }
  return { outcome, reExchangeFailed: false };
}

/**
 * Map a first-page failure to its terminal sync result: a transport/HTTP failure
 * (including a failed mid-cycle token re-exchange) preserves the cursor; a parse
 * failure resets it. Only the first page short-circuits the cycle this way —
 * later-page failures simply stop the walk and commit what was already upserted.
 */
function pageZeroFailureResult(
  fetchResult: PageFetchResult,
  t0: number,
  bytes: number,
  cursor: string | null,
): SyncResult {
  if (fetchResult.reExchangeFailed || fetchResult.outcome.kind === "http_error") {
    return syncPassCursorHttpEmpty(t0, bytes, cursor, pass1Cursor());
  }
  return syncPassCursorParseEmpty(t0, bytes, pass1Cursor());
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
      if (auth.token === null) {
        return syncPassCursorHttpEmpty(t0, auth.bytes, cursor, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      const state: PageWalkState = { token: auth.token, bytes: auth.bytes, reExchanged: false };
      // Cursor pagination: `page.next` is a full URL to the next page (or null
      // at the end). Walk a single forward pass per cycle, page-capped.
      let url: string | null = `${BASE}${TRANSACTIONS_PATH}`;
      for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
        const fetchResult = await fetchTransactionsPage(ctx, creds, url, state);
        if (fetchResult.reExchangeFailed || fetchResult.outcome.kind !== "ok") {
          if (page === 0) {
            return pageZeroFailureResult(fetchResult, t0, state.bytes, cursor);
          }
          break;
        }

        const transactions = extractTransactions(fetchResult.outcome.parsed);
        totalUpserted += upsertTransactions(ctx, transactions, now);
        url = nextPageUrl(fetchResult.outcome.parsed);
      }

      return syncPassCursorSuccess(t0, state.bytes, pass1Cursor(), totalUpserted);
    },
  };
}
