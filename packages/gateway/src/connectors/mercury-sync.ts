import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapMercuryAccountToItem } from "./mercury-account-mapping.ts";
import { mapMercuryTransactionToItem } from "./mercury-transaction-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "mercury";
const CURSOR_PREFIX = "nimbus-mercury1:";
const BASE = "https://api.mercury.com";

/**
 * `GET /api/v1/account/{id}/transactions` accepts `limit` (1..1000) + `offset`
 * and defaults to `order=desc` (newest first). Each cycle re-walks the newest
 * transactions — Ramp's posture — which is why both caps exist:
 *
 * - `MAX_TRANSACTION_PAGES_PER_ACCOUNT` bounds one account at 2 000 rows per
 *   cycle, matching Ramp's 20 x 100 ceiling.
 * - `MAX_TRANSACTION_PAGES` is a budget shared across accounts, so an operator
 *   with many accounts cannot turn one cycle into hundreds of requests.
 */
const TRANSACTIONS_PAGE_SIZE = 500;
const MAX_TRANSACTION_PAGES_PER_ACCOUNT = 4;
const MAX_TRANSACTION_PAGES = 20;

type MercuryCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies MercuryCursorV1);
}

export type MercurySyncableOptions = {
  ensureMercuryMcpRunning: () => Promise<void>;
};

interface MercuryCreds {
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<MercuryCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  return { token };
}

function authHeaders(creds: MercuryCreds): Record<string, string> {
  return { Authorization: `Bearer ${creds.token}`, Accept: "application/json" };
}

function extractAccounts(parsed: unknown): unknown[] {
  const root = asRecord(parsed);
  if (root === undefined) {
    return [];
  }
  const accounts = root["accounts"];
  return Array.isArray(accounts) ? accounts : [];
}

/** `GET /api/v1/account/{id}/transactions` returns `{ total, transactions: [...] }`. */
function extractTransactions(parsed: unknown): unknown[] {
  const transactions = asRecord(parsed)?.["transactions"];
  return Array.isArray(transactions) ? transactions : [];
}

interface AccountPassResult {
  readonly upserted: number;
  /** Ids of the accounts that mapped successfully — the transaction walk's input. */
  readonly accountIds: readonly string[];
}

function upsertAccounts(
  ctx: SyncContext,
  accounts: readonly unknown[],
  now: number,
): AccountPassResult {
  let upserted = 0;
  const accountIds: string[] = [];
  for (const acct of accounts) {
    const mapped = mapMercuryAccountToItem(acct, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
    accountIds.push(mapped.externalId);
  }
  return { upserted, accountIds };
}

function transactionsUrl(accountId: string, offset: number): string {
  const url = new URL(`${BASE}/api/v1/account/${encodeURIComponent(accountId)}/transactions`);
  url.searchParams.set("limit", String(TRANSACTIONS_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order", "desc");
  return url.toString();
}

function upsertTransactions(
  ctx: SyncContext,
  accountId: string,
  transactions: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const txn of transactions) {
    const mapped = mapMercuryTransactionToItem(txn, { syncedAt: now, accountId });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

interface TransactionWalkState {
  upserted: number;
  bytes: number;
  pagesUsed: number;
}

/**
 * Walk one account's transaction pages. A failed page (HTTP or parse) stops
 * THIS account only and leaves everything already upserted committed — the
 * accounts pass has succeeded by this point, so a partial transaction pass must
 * not discard it.
 */
async function walkAccountTransactions(
  ctx: SyncContext,
  creds: MercuryCreds,
  accountId: string,
  now: number,
  state: TransactionWalkState,
): Promise<void> {
  for (let page = 0; page < MAX_TRANSACTION_PAGES_PER_ACCOUNT; page += 1) {
    if (state.pagesUsed >= MAX_TRANSACTION_PAGES) {
      return;
    }
    state.pagesUsed += 1;

    const outcome = await connectorFetch(
      ctx,
      SERVICE_ID,
      transactionsUrl(accountId, page * TRANSACTIONS_PAGE_SIZE),
      { headers: authHeaders(creds) },
    );
    state.bytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      ctx.logger.warn(
        { serviceId: SERVICE_ID, kind: outcome.kind },
        "mercury transactions page failed; keeping the accounts already indexed",
      );
      return;
    }

    const transactions = extractTransactions(outcome.parsed);
    state.upserted += upsertTransactions(ctx, accountId, transactions, now);
    if (transactions.length < TRANSACTIONS_PAGE_SIZE) {
      return;
    }
  }
}

async function syncTransactions(
  ctx: SyncContext,
  creds: MercuryCreds,
  accountIds: readonly string[],
  now: number,
): Promise<TransactionWalkState> {
  const state: TransactionWalkState = { upserted: 0, bytes: 0, pagesUsed: 0 };
  for (const accountId of accountIds) {
    if (state.pagesUsed >= MAX_TRANSACTION_PAGES) {
      break;
    }
    await walkAccountTransactions(ctx, creds, accountId, now, state);
  }
  return state;
}

export function createMercurySyncable(options: MercurySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMercuryMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();

      const outcome = await connectorFetch(ctx, SERVICE_ID, `${BASE}/api/v1/accounts`, {
        headers: authHeaders(creds),
      });
      if (outcome.kind !== "ok") {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, outcome.bytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, outcome.bytes, pass1Cursor());
      }

      const accounts = extractAccounts(outcome.parsed);
      const accountPass = upsertAccounts(ctx, accounts, now);
      const txnPass = await syncTransactions(ctx, creds, accountPass.accountIds, now);

      return syncPassCursorSuccess(
        t0,
        outcome.bytes + txnPass.bytes,
        pass1Cursor(),
        accountPass.upserted + txnPass.upserted,
      );
    },
  };
}
