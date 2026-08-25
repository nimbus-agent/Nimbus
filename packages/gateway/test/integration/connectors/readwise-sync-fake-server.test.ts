import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createReadwiseSyncable } from "../../../src/connectors/readwise-sync.ts";
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

interface FakeReadwiseConfig {
  pages?: unknown[][];
  /** Pages served by `/api/v2/books/`; defaults to a single empty page. */
  bookPages?: unknown[][];
  status?: number;
  badJson?: boolean;
  /** Valid JSON returned verbatim by the highlights path, bypassing the DRF envelope. */
  highlightsBody?: unknown;
}

interface FakeReadwise {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

const HIGHLIGHTS_PATH = "/api/v2/highlights/";
const BOOKS_PATH = "/api/v2/books/";
const DRF_LIST_PATHS = [HIGHLIGHTS_PATH, BOOKS_PATH] as const;
const EMPTY_PAGES: unknown[][] = [[]];

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
      const listPath = DRF_LIST_PATHS.find((p) => p === u.pathname);
      if (listPath !== undefined) {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        if (listPath === HIGHLIGHTS_PATH && config.highlightsBody !== undefined) {
          return Response.json(config.highlightsBody);
        }
        const pages =
          (listPath === HIGHLIGHTS_PATH ? config.pages : config.bookPages) ?? EMPTY_PAGES;
        const page = Number(u.searchParams.get("page") ?? "1");
        const results = pages[page - 1] ?? [];
        const hasNext = page < pages.length && (pages[page] ?? []).length > 0;
        return Response.json({
          count: pages.reduce((n, p) => n + p.length, 0),
          next: hasNext ? `https://readwise.io${listPath}?page=${String(page + 1)}` : null,
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
  vault: ReturnType<typeof createMockVault>;
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
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "readwise"),
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

function book(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Book ${String(id)} — Release It!`,
    author: "Michael T. Nygard",
    category: "books",
    source: "kindle",
    num_highlights: 42,
    cover_image_url: "https://example.com/cover.png",
    highlights_url: `https://readwise.io/bookreview/${String(id)}`,
    source_url: null,
    asin: "B00A32NXZO",
    tags: [{ id: 1, name: "reliability" }],
    document_note: "worth re-reading",
    last_highlight_at: "2024-03-01T12:00:00.000Z",
    updated: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://readwise.io", fakeBase);
    return original(rewritten, init);
  };
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
    await h.vault.set("readwise.token", "readwise_test_token");

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
    await h.vault.set("readwise.token", "k");

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
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/highlights/");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20);
  });

  test("the source url is the canonical url; book highlights (null url) → null", async () => {
    h = startHarness({ pages: [[highlight(1), highlight(2, { url: null })]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'readwise' AND external_id = '1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://example.com/article");
    const fromBook = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'readwise' AND external_id = '2'",
      )
      .get();
    expect(fromBook?.canonical_url).toBeNull();
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
    await h.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");
    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("a valid-JSON but non-object page body degrades to zero items", async () => {
    h = startHarness({ highlightsBody: [], bookPages: [[book(9001)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    // The highlights walk yields nothing; the books walk is unaffected.
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("a page envelope with no `results` array degrades to zero items", async () => {
    h = startHarness({ highlightsBody: { count: 0, next: null, previous: null } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-readwise1:")).toBe(true);
  });

  test("books walk: `/api/v2/books/` upserts readwise:book/<id> rows with Token auth", async () => {
    h = startHarness({ pages: [[highlight(1)]], bookPages: [[book(9001), book(9002)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "readwise_test_token");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    const bookReqs = h.fake.requests.filter((r) => r.path === BOOKS_PATH);
    expect(bookReqs).toHaveLength(1);
    expect(bookReqs[0]?.query).toContain("page_size=1000");
    expect(bookReqs[0]?.authorization).toBe("Token readwise_test_token");

    const rows = h.db
      .query<{ id: string; external_id: string; title: string }, []>(
        "SELECT id, external_id, title FROM item WHERE service = 'readwise' AND type = 'book' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["book/9001", "book/9002"]);
    expect(rows.map((r) => r.id)).toEqual(["readwise:book/9001", "readwise:book/9002"]);
    expect(rows[0]?.title).toBe("Book 9001 — Release It!");
  });

  test("a book and a highlight sharing the numeric id both survive the sync", async () => {
    h = startHarness({ pages: [[highlight(9001)]], bookPages: [[book(9001)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const rows = h.db
      .query<{ id: string; type: string }, []>(
        "SELECT id, type FROM item WHERE service = 'readwise' ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "readwise:9001", type: "highlight" },
      { id: "readwise:book/9001", type: "book" },
    ]);
  });

  test("the book's metadata.book_id joins its highlights' metadata.book_id", async () => {
    h = startHarness({
      pages: [[highlight(1, { book_id: 9001 })]],
      bookPages: [[book(9001)]],
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const joined = h.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM item h
           JOIN item b ON b.service = 'readwise' AND b.type = 'book'
             AND json_extract(b.metadata, '$.book_id') = json_extract(h.metadata, '$.book_id')
          WHERE h.service = 'readwise' AND h.type = 'highlight'`,
      )
      .get();
    expect(joined?.n).toBe(1);
  });

  test("the books walk paginates independently of the highlights walk", async () => {
    h = startHarness({
      pages: [[highlight(1)]],
      bookPages: [[book(9001)], [book(9002)], [book(9003)]],
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(4);
    expect(h.fake.requests.filter((r) => r.path === HIGHLIGHTS_PATH)).toHaveLength(1);
    expect(
      h.fake.requests
        .filter((r) => r.path === BOOKS_PATH)
        .map((r) => new URL(`https://x${r.query}`).searchParams.get("page")),
    ).toEqual(["1", "2", "3"]);
  });

  test("an empty books page leaves the highlight upserts untouched", async () => {
    h = startHarness({ pages: [[highlight(1), highlight(2)]], bookPages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const books = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM item WHERE service = 'readwise' AND type = 'book'",
      )
      .get();
    expect(books?.n).toBe(0);
  });

  test("book rows carry epoch-ms timestamps and the Readwise book-review canonical url", async () => {
    h = startHarness({ pages: [[]], bookPages: [[book(9001)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("readwise.token", "k");

    const syncable = createReadwiseSyncable({ ensureReadwiseMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ canonical_url: string | null; modified_at: number; metadata: string }, []>(
        "SELECT canonical_url, modified_at, metadata FROM item WHERE id = 'readwise:book/9001'",
      )
      .get();
    expect(row?.canonical_url).toBe("https://readwise.io/bookreview/9001");
    expect(row?.modified_at).toBe(Date.parse("2024-03-02T08:00:00.000Z"));
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["last_highlight_at"]).toBe(Date.parse("2024-03-01T12:00:00.000Z"));
    expect(meta["cover_image_url"]).toBeUndefined();
  });
});
