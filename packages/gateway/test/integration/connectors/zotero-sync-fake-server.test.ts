import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createZoteroSyncable } from "../../../src/connectors/zotero-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const LIBRARY = "users/12345";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  apiKey: string | null;
  apiVersion: string | null;
}

interface FakeZoteroConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeZotero {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeZotero(config: FakeZoteroConfig): FakeZotero {
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
        apiKey: req.headers.get("zotero-api-key"),
        apiVersion: req.headers.get("zotero-api-version"),
      });
      if (u.pathname === `/${LIBRARY}/items`) {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("[not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const start = Number(u.searchParams.get("start") ?? "0");
        const pageIndex = Math.floor(start / 100);
        const results = pages[pageIndex] ?? [];
        return Response.json(results);
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
  fake: FakeZotero;
  cleanup: () => void;
}

function startHarness(config: FakeZoteroConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeZotero(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "zotero"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        zotero: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function reference(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { data: dataOver, ...rootOver } = over;
  return {
    key,
    version: 100,
    library: { type: "user", id: 12345 },
    ...rootOver,
    data: {
      key,
      itemType: "journalArticle",
      title: `Reference ${key} — exponential backoff with jitter`,
      abstractNote: "Full-jitter retry strategies for distributed queues.",
      DOI: "10.1145/1234567.8901234",
      url: "https://example.com/article",
      creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
      tags: [{ tag: "reliability" }],
      collections: ["COLL01"],
      dateModified: "2024-03-02T08:00:00Z",
      dateAdded: "2024-03-01T12:00:00Z",
      ...dataOver,
    },
  };
}

async function setCreds(h: Harness): Promise<void> {
  await h.vault.set("zotero.api_key", "zk_test_key");
  await h.vault.set("zotero.library", LIBRARY);
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.zotero.org", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("zotero-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with zotero:<key> ids + Zotero-API-Key auth", async () => {
    h = startHarness({ pages: [[reference("ABC1"), reference("ABC2")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);

    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-zotero1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === `/${LIBRARY}/items`);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("limit=100");
    expect(reqs[0]?.query).toContain("start=0");
    expect(reqs[0]?.query).toContain("sort=dateModified");
    for (const r of reqs) {
      expect(r.apiKey).toBe("zk_test_key");
      expect(r.apiVersion).toBe("3");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'zotero' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["ABC1", "ABC2"]);
    expect(rows.map((r) => r.id)).toEqual(["zotero:ABC1", "zotero:ABC2"]);
  });

  test("offset walk: follows start across full pages, stops on a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => reference(`A${String(i)}`));
    h = startHarness({ pages: [full, [reference("B0"), reference("B1")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);

    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(102);
    const reqs = h.fake.requests.filter((r) => r.path === `/${LIBRARY}/items`);
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("start"))).toEqual([
      "0",
      "100",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, () =>
      Array.from({ length: 100 }, (_, i) => reference(`K${String(i)}`)),
    );
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);

    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === `/${LIBRARY}/items`);
    expect(reqs).toHaveLength(20);
  });

  test("skips attachment + note item types", async () => {
    h = startHarness({
      pages: [
        [
          reference("ABC1"),
          reference("ATT1", { data: { itemType: "attachment" } }),
          reference("NOTE1", { data: { itemType: "note" } }),
        ],
      ],
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);

    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'zotero' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["ABC1"]);
  });

  test("noop when creds unset — no requests", async () => {
    h = startHarness({ pages: [[reference("ABC1")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when only api_key is set (library required)", async () => {
    h = startHarness({ pages: [[reference("ABC1")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("zotero.api_key", "zk_test_key");
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty item list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zotero1:")).toBe(true);
  });

  test("first-page 429 (rate-limited) degrades gracefully (no throw, zero upserts, cursor preserved)", async () => {
    h = startHarness({ status: 429 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const incoming = "nimbus-zotero1:existing";
    const result = await syncable.sync(h.ctx, incoming);
    expect(result.itemsUpserted).toBe(0);
    // http_error on page 0 preserves the incoming cursor
    expect(result.cursor).toBe(incoming);
  });

  test("first-page 401 (auth failure) degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ status: 401 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    // http_error on page 0 with null incoming cursor → falls back to the pass-1 cursor
    expect(result.cursor?.startsWith("nimbus-zotero1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zotero1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await setCreds(h);
    const syncable = createZoteroSyncable({ ensureZoteroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zotero1:")).toBe(true);
  });
});
