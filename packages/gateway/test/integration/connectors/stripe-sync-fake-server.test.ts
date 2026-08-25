import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createStripeSyncable } from "../../../src/connectors/stripe-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface StripePage {
  data: unknown[];
  has_more: boolean;
}

interface FakeStripeConfig {
  pages?: Record<string, StripePage>;
  status?: number;
  badJson?: boolean;
}

interface FakeStripe {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeStripe(config: FakeStripeConfig): FakeStripe {
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
      if (u.pathname === "/v1/invoices") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const after = u.searchParams.get("starting_after") ?? "";
        const page = config.pages?.[after] ?? { data: [], has_more: false };
        return Response.json({ object: "list", data: page.data, has_more: page.has_more });
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
  fake: FakeStripe;
  cleanup: () => void;
}

function startHarness(config: FakeStripeConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeStripe(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "stripe"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        stripe: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function invoice(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "invoice",
    number: `INV-${id}`,
    status: "paid",
    customer: `cus_${id}`,
    customer_name: "Acme Inc",
    customer_email: "billing@acme.test",
    amount_due: 1250,
    amount_paid: 1250,
    currency: "usd",
    description: `invoice ${id}`,
    hosted_invoice_url: `https://pay.stripe.com/invoice/${id}`,
    invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
    created: 1_700_000_000,
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.stripe.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function fullPage(prefix: string): unknown[] {
  return Array.from({ length: 100 }, (_, i) => invoice(`${prefix}_${String(i)}`));
}

describe("stripe-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with stripe:<id> ids + Bearer auth", async () => {
    h = startHarness({ pages: { "": { data: [invoice("i1"), invoice("i2")], has_more: false } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "sk_test_token");

    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-stripe1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer sk_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'stripe' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["i1", "i2"]);
    expect(rows.map((r) => r.id)).toEqual(["stripe:i1", "stripe:i2"]);
  });

  test("multi-page: has_more drives a starting_after cursor walk", async () => {
    const firstPage = fullPage("a");
    const lastId = (firstPage.at(-1) as { id: string }).id;
    h = startHarness({
      pages: {
        "": { data: firstPage, has_more: true },
        [lastId]: { data: [invoice("b1")], has_more: false },
      },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "k");

    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const reqs = h.fake.requests.filter((r) => r.path === "/v1/invoices");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.query).not.toContain("starting_after");
    expect(reqs[1]?.query).toContain(`starting_after=${lastId}`);
  });

  test("MAX_PAGES cap: perpetual has_more stops after 20 pages", async () => {
    h = startHarness({});
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "k");

    h.fake.stop();
    let serial = 0;
    const requests: RecordedReq[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        requests.push({
          method: req.method,
          path: u.pathname,
          query: u.search,
          authorization: req.headers.get("authorization"),
        });
        const data = Array.from({ length: 100 }, () => {
          serial += 1;
          return invoice(`i_${String(serial)}`);
        });
        return Response.json({ object: "list", data, has_more: true });
      },
    });
    const fakeBase = `http://${server.hostname}:${server.port}`;
    restoreFetch?.();
    restoreFetch = withRewrittenFetch(fakeBase);

    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(requests.filter((r) => r.path === "/v1/invoices")).toHaveLength(20);
    expect(result.itemsUpserted).toBe(2000);
    server.stop(true);
  });

  test("noop when api key unset — no requests", async () => {
    h = startHarness({ pages: { "": { data: [invoice("i1")], has_more: false } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: { "": { data: [], has_more: false } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "k");
    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stripe1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "k");
    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stripe1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stripe.api_key", "k");
    const syncable = createStripeSyncable({ ensureStripeMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stripe1:")).toBe(true);
  });
});
