import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createRaindropSyncable } from "../../../src/connectors/raindrop-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface FakeRaindropConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeRaindrop {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeRaindrop(config: FakeRaindropConfig): FakeRaindrop {
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
      if (u.pathname === "/rest/v1/raindrops/0") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const page = Number(u.searchParams.get("page") ?? "0");
        const items = pages[page] ?? [];
        return Response.json({
          result: true,
          items,
          count: pages.reduce((n, p) => n + p.length, 0),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  db: Database;
  ctx: SyncContext;
  fake: FakeRaindrop;
  cleanup: () => void;
}

function startHarness(config: FakeRaindropConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeRaindrop(config);
  return {
    db,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      vault,
      db,
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        raindrop: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function bookmark(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: id,
    title: `Bookmark ${String(id)} — exponential backoff with jitter`,
    excerpt: "a clear explanation",
    note: "use full jitter",
    link: "https://example.com/article",
    domain: "example.com",
    type: "article",
    tags: ["reliability"],
    cover: "https://example.com/cover.png",
    collectionId: 9001,
    created: "2024-03-01T12:00:00.000Z",
    lastUpdate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

function fullPage(base: number): unknown[] {
  return Array.from({ length: 50 }, (_, i) => bookmark(base + i));
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.raindrop.io", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("raindrop-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single short page → upserts with raindrop:<id> ids + Bearer auth", async () => {
    h = startHarness({ pages: [[bookmark(1), bookmark(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "raindrop_test_token");

    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-raindrop1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/rest/v1/raindrops/0");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("perpage=50");
    expect(reqs[0]?.query).toContain("page=0");
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer raindrop_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'raindrop' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["raindrop:1", "raindrop:2"]);
  });

  test("0-based page walk: continues on a full page, stops on a short page", async () => {
    h = startHarness({ pages: [fullPage(1), [bookmark(100)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");

    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(51);
    const reqs = h.fake.requests.filter((r) => r.path === "/rest/v1/raindrops/0");
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("page"))).toEqual([
      "0",
      "1",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => fullPage(i * 50 + 1));
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");

    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/rest/v1/raindrops/0");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20 * 50);
  });

  test("the link is the canonical url; missing-link bookmarks → null", async () => {
    h = startHarness({ pages: [[bookmark(1), bookmark(2, { link: null })]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");

    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'raindrop' AND external_id = '1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://example.com/article");
    const noLink = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'raindrop' AND external_id = '2'",
      )
      .get();
    expect(noLink?.canonical_url).toBeNull();
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: [[bookmark(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty bookmark list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");
    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-raindrop1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");
    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-raindrop1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("raindrop.token", "k");
    const syncable = createRaindropSyncable({ ensureRaindropMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-raindrop1:")).toBe(true);
  });
});
