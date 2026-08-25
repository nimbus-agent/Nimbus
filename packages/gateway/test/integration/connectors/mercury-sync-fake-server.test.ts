import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createMercurySyncable } from "../../../src/connectors/mercury-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

/** Mirrors `TRANSACTIONS_PAGE_SIZE` in mercury-sync.ts. */
const PAGE_SIZE = 500;
/** Mirrors `MAX_TRANSACTION_PAGES_PER_ACCOUNT` in mercury-sync.ts. */
const MAX_PAGES_PER_ACCOUNT = 4;
/** Mirrors `MAX_TRANSACTION_PAGES` in mercury-sync.ts. */
const MAX_PAGES_TOTAL = 20;

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface FakeMercuryConfig {
  accounts?: unknown[];
  status?: number;
  badJson?: boolean;
  /** Per-account transaction rows, returned as one short page. */
  transactions?: Record<string, unknown[]>;
  /** Accounts whose transaction pages are always FULL (exercises the page caps). */
  alwaysFullTransactions?: boolean;
  /** HTTP status for every transactions request (exercises the degrade path). */
  transactionsStatus?: number;
  /** Serve invalid JSON from every transactions request. */
  transactionsBadJson?: boolean;
}

interface FakeMercury {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

const TRANSACTIONS_PATH = /^\/api\/v1\/account\/([^/]+)\/transactions$/;

function fullPage(accountId: string, offset: number): unknown[] {
  return Array.from({ length: PAGE_SIZE }, (_, i) => ({
    id: `txn_${accountId}_${String(offset + i)}`,
    accountId,
    amount: -1,
    status: "sent",
  }));
}

function startFakeMercury(config: FakeMercuryConfig): FakeMercury {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        query: u.search,
        authorization: req.headers.get("authorization"),
      });
      if (u.pathname === "/api/v1/accounts") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        return Response.json({ accounts: config.accounts ?? [] });
      }
      const txnMatch = TRANSACTIONS_PATH.exec(u.pathname);
      if (txnMatch !== null) {
        if (config.transactionsStatus !== undefined) {
          return new Response("error", { status: config.transactionsStatus });
        }
        if (config.transactionsBadJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const accountId = decodeURIComponent(txnMatch[1] ?? "");
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const rows =
          config.alwaysFullTransactions === true
            ? fullPage(accountId, offset)
            : (config.transactions?.[accountId] ?? []);
        return Response.json({ total: rows.length, transactions: rows });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeMercury;
  cleanup: () => void;
}

function startHarness(config: FakeMercuryConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeMercury(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "mercury"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        mercury: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function account(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Account ${id}`,
    status: "active",
    type: "mercury",
    kind: "checking",
    accountNumber: "9876543210",
    routingNumber: "021000021",
    availableBalance: 12345.67,
    currentBalance: 12300,
    legalBusinessName: "Acme Inc",
    createdAt: "2024-03-01T12:00:00.000Z",
    ...over,
  };
}

function transaction(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    accountId: "a1",
    amount: -4212.55,
    status: "sent",
    kind: "externalTransfer",
    counterpartyName: "Amazon Web Services",
    bankDescription: "AWS EMEA SARL",
    mercuryCategory: "Software",
    note: "Monthly AWS production bill",
    createdAt: "2024-03-01T12:00:00.000Z",
    postedAt: "2024-03-02T08:00:00.000Z",
    dashboardLink: `https://mercury.com/transactions/${id}`,
    details: {
      electronicRoutingInfo: {
        accountNumber: "1112223334",
        routingNumber: "121000248",
        bankName: "Counterparty Bank",
      },
      address: { address1: "1 Infinite Loop", city: "Cupertino", postalCode: "95014" },
    },
    attachments: [{ fileName: "receipt-secret.pdf" }],
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.mercury.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function transactionRequests(fake: FakeMercury): RecordedReq[] {
  return fake.requests.filter((r) => TRANSACTIONS_PATH.test(r.path));
}

describe("mercury-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single GET → upserts with mercury:<id> ids + Bearer auth", async () => {
    h = startHarness({ accounts: [account("a1"), account("a2")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "mercury_test_token");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v1/accounts");
    expect(reqs).toHaveLength(1);
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer mercury_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'mercury' AND type = 'account' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["a1", "a2"]);
    expect(rows.map((r) => r.id)).toEqual(["mercury:a1", "mercury:a2"]);
  });

  test("the full account number is never persisted (last-4 only)", async () => {
    h = startHarness({ accounts: [account("a1")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'mercury' AND external_id = 'a1'",
      )
      .get();
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.metadata).not.toContain("9876543210");
    expect(row.metadata).toContain("3210");
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ accounts: [account("a1")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty account list → zero upserts, pass-1 cursor, no transaction requests", async () => {
    h = startHarness({ accounts: [] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
    expect(transactionRequests(h.fake)).toHaveLength(0);
  });

  test("5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
  });

  test("parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
  });
});

describe("mercury-sync transactions pass", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("indexes mercury:transaction rows per account, newest-first + paginated", async () => {
    h = startHarness({
      accounts: [account("a1"), account("a2")],
      transactions: { a1: [transaction("t1"), transaction("t2")], a2: [] },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    // 2 accounts + 2 transactions.
    expect(result.itemsUpserted).toBe(4);

    const reqs = transactionRequests(h.fake);
    expect(reqs.map((r) => r.path)).toEqual([
      "/api/v1/account/a1/transactions",
      "/api/v1/account/a2/transactions",
    ]);
    for (const r of reqs) {
      expect(r.query).toContain(`limit=${String(PAGE_SIZE)}`);
      expect(r.query).toContain("offset=0");
      expect(r.query).toContain("order=desc");
      expect(r.authorization).toBe("Bearer k");
    }

    const rows = h.db
      .query<{ id: string; external_id: string; title: string; url: string | null }, []>(
        "SELECT id, external_id, title, url FROM item WHERE service = 'mercury' AND type = 'transaction' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["t1", "t2"]);
    expect(rows.map((r) => r.id)).toEqual(["mercury:t1", "mercury:t2"]);
    expect(rows[0]?.title).toBe("Amazon Web Services — -4212.55 USD");
    expect(rows[0]?.url).toBe("https://mercury.com/transactions/t1");
  });

  test("counterparty bank credentials + receipts are never persisted", async () => {
    h = startHarness({
      accounts: [account("a1")],
      transactions: { a1: [transaction("t1")] },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE id = 'mercury:t1'")
      .get();
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.metadata).not.toContain("1112223334");
    expect(row.metadata).not.toContain("121000248");
    expect(row.metadata).not.toContain("Counterparty Bank");
    expect(row.metadata).not.toContain("1 Infinite Loop");
    expect(row.metadata).not.toContain("receipt-secret.pdf");
    expect(row.metadata).toContain("Amazon Web Services");
  });

  test("a transactions failure keeps the accounts already indexed", async () => {
    h = startHarness({ accounts: [account("a1")], transactionsStatus: 500 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
    expect(h.db.query("SELECT id FROM item WHERE id = 'mercury:a1'").get()).not.toBeNull();
    // The failed account is not retried within the same cycle.
    expect(transactionRequests(h.fake)).toHaveLength(1);
  });

  test("a transactions parse error keeps the accounts already indexed", async () => {
    h = startHarness({ accounts: [account("a1")], transactionsBadJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    expect(transactionRequests(h.fake)).toHaveLength(1);
  });

  test("a full page advances the offset and stops at the per-account page cap", async () => {
    h = startHarness({ accounts: [account("a1")], alwaysFullTransactions: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const reqs = transactionRequests(h.fake);
    expect(reqs).toHaveLength(MAX_PAGES_PER_ACCOUNT);
    expect(reqs.map((r) => new URLSearchParams(r.query).get("offset"))).toEqual(
      Array.from({ length: MAX_PAGES_PER_ACCOUNT }, (_, i) => String(i * PAGE_SIZE)),
    );
  });

  test("the shared page budget caps a many-account cycle", async () => {
    const accountIds = Array.from({ length: MAX_PAGES_TOTAL + 5 }, (_, i) => `a${String(i)}`);
    h = startHarness({
      accounts: accountIds.map((id) => account(id)),
      transactions: Object.fromEntries(
        accountIds.map((id) => [id, [transaction(`t_${id}`, { accountId: id })]]),
      ),
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(transactionRequests(h.fake)).toHaveLength(MAX_PAGES_TOTAL);
    // Every account still indexed; only the transaction walk is budget-capped.
    expect(result.itemsUpserted).toBe(accountIds.length + MAX_PAGES_TOTAL);
  });

  test("a transaction without an id is skipped", async () => {
    h = startHarness({
      accounts: [account("a1")],
      transactions: { a1: [{ amount: -1 }, transaction("t9")] },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    // 1 account + 1 mappable transaction.
    expect(result.itemsUpserted).toBe(2);
  });

  test("a response with no transactions key yields no transaction rows", async () => {
    h = startHarness({ accounts: [account("a1")], transactions: {} });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });
});
