import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createRampSyncable } from "../../../src/connectors/ramp-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  pageSize: string | null;
}

interface FakeRampConfig {
  transactions: Record<string, unknown>[];
  tokenStatus?: number;
  tokenAccessToken?: string | null;
  transactionsStatus?: number;
  // When set, the data endpoint returns 401 until the token has been
  // re-exchanged at least `failDataUntilTokenExchanges` times.
  failDataUntilTokenExchanges?: number;
}

interface FakeRamp {
  baseHost: string;
  requests: RecordedReq[];
  tokenExchanges: number;
  stop(): void;
}

const PAGE_SIZE = 100;

function startFakeRamp(config: FakeRampConfig): FakeRamp {
  const requests: RecordedReq[] = [];
  const state = { tokenExchanges: 0 };
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        pageSize: u.searchParams.get("page_size"),
      });
      if (u.pathname === "/developer/v1/token") {
        await req.text();
        state.tokenExchanges += 1;
        if (config.tokenStatus !== undefined && config.tokenStatus !== 200) {
          return new Response("token error", { status: config.tokenStatus });
        }
        const token = config.tokenAccessToken === undefined ? "tok" : config.tokenAccessToken;
        return Response.json(
          token === null
            ? { token_type: "Bearer", expires_in: 3600 }
            : { access_token: token, token_type: "Bearer", expires_in: 3600 },
        );
      }
      if (u.pathname === "/developer/v1/transactions") {
        if (
          config.failDataUntilTokenExchanges !== undefined &&
          state.tokenExchanges < config.failDataUntilTokenExchanges
        ) {
          return new Response("expired", { status: 401 });
        }
        if (config.transactionsStatus !== undefined && config.transactionsStatus !== 200) {
          return new Response("error", { status: config.transactionsStatus });
        }
        const start = Number.parseInt(u.searchParams.get("start") ?? "0", 10);
        const slice = config.transactions.slice(start, start + PAGE_SIZE);
        const nextStart = start + PAGE_SIZE;
        const hasNext = nextStart < config.transactions.length;
        const next = hasNext
          ? `http://${server?.hostname}:${server?.port}/developer/v1/transactions?page_size=100&start=${String(nextStart)}`
          : null;
        return Response.json({ data: slice, page: { next } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseHost: `http://${server.hostname}:${server.port}`,
    requests,
    get tokenExchanges() {
      return state.tokenExchanges;
    },
    stop: () => server?.stop(true),
  };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeRamp;
  cleanup: () => void;
}

function startHarness(config: FakeRampConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeRamp(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "ramp"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        ramp: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function txn(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    amount: 100.5,
    currency_code: "USD",
    merchant_name: `merchant-${id}`,
    state: "CLEARED",
    sk_category_name: "Software",
    user_transaction_time: "2024-03-02T08:00:00Z",
    memo: `memo for ${id}`,
    card_holder: { first_name: "Ada", last_name: "Lovelace", department_name: "Eng" },
    ...over,
  };
}

async function seedCreds(h: Harness): Promise<void> {
  await h.vault.set("ramp.client_id", "cid_test");
  await h.vault.set("ramp.client_secret", "csecret_test");
}

// The connector uses the fixed host https://api.ramp.com. To exercise the fake
// server we point the connector at it by overriding global fetch to rewrite the
// api.ramp.com origin to the fake server origin.
function withRampHostRewrite<T>(host: string, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://api.ramp.com", host);
    return realFetch(rewritten, init);
  };
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

describe("ramp-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: exchanges token, lists with Bearer, follows page.next, upserts rows", async () => {
    const many = Array.from({ length: 100 }, (_, i) => txn(`txn_${String(i)}`));
    const extra = [txn("txn_100", { merchant_name: "Final" })];
    h = startHarness({ transactions: [...many, ...extra] });
    await seedCreds(h);

    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));

    expect(result.itemsUpserted).toBe(101);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-ramp1:")).toBe(true);

    const tokenPosts = h.fake.requests.filter(
      (r) => r.path === "/developer/v1/token" && r.method === "POST",
    );
    expect(tokenPosts).toHaveLength(1);
    expect(tokenPosts[0]?.auth?.startsWith("Basic ")).toBe(true);

    const gets = h.fake.requests.filter((r) => r.path === "/developer/v1/transactions");
    // page.next cursor → two pages followed
    expect(gets).toHaveLength(2);
    for (const r of gets) {
      expect(r.auth).toBe("Bearer tok");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'ramp' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(101);
    const last = rows.find((r) => r.external_id === "txn_100");
    expect(last).toBeDefined();
    const m = JSON.parse(last?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["merchant_name"]).toBe("Final");
    expect(m["card_holder_name"]).toBe("Ada Lovelace");
  });

  test("noop when either credential unset — no requests", async () => {
    h = startHarness({ transactions: [txn("txn_1")] });
    await h.vault.set("ramp.client_id", "cid_test");
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("token exchange failure (5xx) → graceful empty pass: no data GET", async () => {
    h = startHarness({ transactions: [txn("txn_1")], tokenStatus: 503 });
    await seedCreds(h);
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-ramp1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/developer/v1/token")).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.path === "/developer/v1/transactions")).toHaveLength(0);
  });

  test("token exchange ok but no access_token → graceful empty pass (no data GET)", async () => {
    h = startHarness({ transactions: [txn("txn_1")], tokenAccessToken: null });
    await seedCreds(h);
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests.filter((r) => r.path === "/developer/v1/transactions")).toHaveLength(0);
  });

  test("a 429 on the first data page degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ transactions: [txn("txn_1")], transactionsStatus: 429 });
    await seedCreds(h);
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-ramp1:")).toBe(true);
  });

  test("a persistent 401 on data → re-exchange once, still fails → graceful empty pass", async () => {
    h = startHarness({ transactions: [txn("txn_1")], transactionsStatus: 401 });
    await seedCreds(h);
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-ramp1:")).toBe(true);
    // Initial exchange + exactly one re-exchange on the 401.
    expect(h.fake.tokenExchanges).toBe(2);
  });

  test("a transient 401 (token expired) → re-exchange once, then succeeds", async () => {
    h = startHarness({
      transactions: [txn("txn_1"), txn("txn_2")],
      failDataUntilTokenExchanges: 2,
    });
    await seedCreds(h);
    const syncable = createRampSyncable({ ensureRampMcpRunning: async () => {} });
    const result = await withRampHostRewrite(h.fake.baseHost, () => syncable.sync(h!.ctx, null));
    expect(result.itemsUpserted).toBe(2);
    expect(h.fake.tokenExchanges).toBe(2);
    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'ramp' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["txn_1", "txn_2"]);
  });
});
