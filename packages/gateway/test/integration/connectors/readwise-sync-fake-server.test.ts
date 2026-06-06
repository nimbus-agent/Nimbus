import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createReadwiseSyncable } from "../../../src/connectors/readwise-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface FakeReadwiseConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeReadwise {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeReadwise(config: FakeReadwiseConfig): FakeReadwise {
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
      if (u.pathname === "/api/v2/highlights/") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const page = Number(u.searchParams.get("page") ?? "1");
        const results = pages[page - 1] ?? [];
        const hasNext = page < pages.length && (pages[page] ?? []).length > 0;
        return Response.json({
          count: pages.reduce((n, p) => n + p.length, 0),
          next: hasNext ? `https://readwise.io/api/v2/highlights/?page=${String(page + 1)}` : null,
          previous: null,
          results,
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
  fake: FakeReadwise;
  cleanup: () => void;
}

function startHarness(config: FakeReadwiseConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeReadwise(config);
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
        readwise: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function highlight(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    text: `Highlight ${String(id)} — exponential backoff with jitter`,
    note: "use full jitter",
    location: 42,
    location_type: "location",
    color: "yellow",
    book_id: 9001,
    url: "https://example.com/article",
    tags: [{ id: 1, name: "reliability" }],
    highlighted_at: "2024-03-01T12:00:00.000Z",
    updated: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const rewritten = urlStr.replace("https://readwise.io", fakeBase);
    return original(rewritten, init);
  });
  return () => {
    globalThis.fetch = original;
  };
}

describe("readwise-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with readwise:<id> ids + Token auth", async () => {
    h = startHarness({ pages: [[highlight(1), highlight(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "readwise_test_token");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/highlights/");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("page_size=1000");
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Token readwise_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'readwise' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["readwise:1", "readwise:2"]);
  });

  test("page-number walk: follows `next` across pages, stops on null next", async () => {
    h = startHarness({
      pages: [[highlight(1), highlight(2)], [highlight(3)]],
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/highlights/");
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => [highlight(i + 1)]);
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/highlights/");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20);
  });

  test("the source url is the canonical url; book highlights (null url) → null", async () => {
    h = startHarness({ pages: [[highlight(1), highlight(2, { url: null })]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'readwise' AND external_id = '1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://example.com/article");
    const book = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'readwise' AND external_id = '2'",
      )
      .get();
    expect(book?.canonical_url).toBeNull();
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: [[highlight(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty highlight list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });
});
