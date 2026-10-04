/**
 * Mercury paths the fake-server suite does not reach: account and transaction bodies of the wrong
 * shape, an account that does not map, and the SHARED transaction-page budget running out in the
 * middle of an account's walk (rather than between accounts).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createMercurySyncable } from "./mercury-sync.ts";
import { decodeNimbusJsonCursorObject } from "./nimbus-json-cursor.ts";

const ACCOUNTS_URL = "https://api.mercury.com/api/v1/accounts";
const TXN_RE = /^https:\/\/api\.mercury\.com\/api\/v1\/account\/([^/]+)\/transactions\?/;
/** Mirrors `TRANSACTIONS_PAGE_SIZE` in mercury-sync.ts. */
const PAGE_SIZE = 500;

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function sync() {
  return createMercurySyncable({ ensureMercuryMcpRunning: async () => {} }).sync(
    {
      ...syncTestContext(db, createStubVault({ "mercury.token": "tok" }), "mercury"),
      // Mercury's real quota (60 rpm, burst 10) would make the 21-request budget walk below wait
      // ~11 s of wall-clock; the limiter is not what these tests are about.
      rateLimiter: new ProviderRateLimiter({
        mercury: { requestsPerMinute: 600_000, burstSize: 100 },
      }),
    },
    null,
  );
}

function transactionCalls(): { account: string; offset: string | null }[] {
  return fetchStub.calls
    .filter((c) => TXN_RE.test(c.url))
    .map((c) => ({
      account: TXN_RE.exec(c.url)?.[1] ?? "",
      offset: new URL(c.url).searchParams.get("offset"),
    }));
}

function mercuryIds(): string[] {
  return (
    db
      .query("SELECT external_id FROM item WHERE service = 'mercury' ORDER BY external_id")
      .all() as { external_id: string }[]
  ).map((r) => r.external_id);
}

describe("mercury-sync — wrong-shaped bodies", () => {
  test("an accounts body that is a bare array indexes nothing and walks no transactions", async () => {
    fetchStub.respond("GET", ACCOUNTS_URL, [{ id: "a1", name: "Ops" }]);

    const res = await sync();

    expect(res.itemsUpserted).toBe(0);
    expect(decodeNimbusJsonCursorObject(res.cursor, "nimbus-mercury1:")).toEqual({ pass: 1 });
    expect(transactionCalls()).toEqual([]);
  });

  test("an `accounts` field that is not an array indexes nothing", async () => {
    // A lone account OBJECT that would map on its own, so "indexes nothing" proves the field was
    // ignored rather than read as a one-entry list of something unmappable.
    fetchStub.respond("GET", ACCOUNTS_URL, { accounts: { id: "a1", name: "Ops" } });

    const res = await sync();

    expect(res.itemsUpserted).toBe(0);
    expect(mercuryIds()).toEqual([]);
    expect(transactionCalls()).toEqual([]);
  });

  test("an account without an id is skipped and never walked; a `transactions` object yields no rows", async () => {
    fetchStub.respond("GET", ACCOUNTS_URL, {
      accounts: [{ name: "no id" }, { id: "a1", name: "Ops" }],
    });
    // Likewise a lone, mappable transaction object rather than an array of them.
    fetchStub.respond("GET", TXN_RE, { total: 1, transactions: { id: "t1", amount: -12.5 } });

    const res = await sync();

    expect(res.itemsUpserted).toBe(1);
    expect(mercuryIds()).toEqual(["a1"]);
    expect(transactionCalls()).toEqual([{ account: "a1", offset: "0" }]);
  });
});

describe("mercury-sync — shared transaction-page budget", () => {
  test("the budget can run out part-way through an account, which then stops early", async () => {
    const accounts = ["a1", "a2", "a3", "a4", "a5", "a6"];
    fetchStub.respond("GET", ACCOUNTS_URL, { accounts: accounts.map((id) => ({ id })) });
    // a1: one short page → 1 page used. a2..a5: always-full pages → 4 pages each (the per-account
    // cap) → 17 used. a6 then has only 3 of its 4 pages left in the shared budget of 20. The full
    // pages hold id-less rows so nothing is written — only the page accounting is under test.
    fetchStub.respond("GET", /\/account\/a1\/transactions\?/, { transactions: [] });
    const fullPage = { transactions: Array.from({ length: PAGE_SIZE }, () => ({})) };
    fetchStub.respond("GET", TXN_RE, fullPage);

    const res = await sync();

    const calls = transactionCalls();
    expect(calls).toHaveLength(20);
    expect(calls.filter((c) => c.account === "a6").map((c) => c.offset)).toEqual([
      "0",
      "500",
      "1000",
    ]);
    expect(calls.filter((c) => c.account === "a2")).toHaveLength(4);
    // Accounts are still indexed even though their transaction walks were capped.
    expect(res.itemsUpserted).toBe(6);
  });
});
