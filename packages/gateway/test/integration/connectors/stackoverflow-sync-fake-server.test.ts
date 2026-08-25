import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createStackOverflowSyncable } from "../../../src/connectors/stackoverflow-sync.ts";
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

interface FakeStackOverflowConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeStackOverflow {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

const TEAM = "acme team";
function startFakeStackOverflow(config: FakeStackOverflowConfig): FakeStackOverflow {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  const pages = config.pages ?? [[]];
  const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
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
      if (u.pathname === expectedPath) {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const page = Number(u.searchParams.get("page") ?? "1");
        const items = pages[page - 1] ?? [];
        return Response.json({
          items,
          totalCount: pages.reduce((n, p) => n + p.length, 0),
          pageSize: 100,
          page,
          totalPages: pages.length,
          sort: "creation",
          order: "desc",
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
  fake: FakeStackOverflow;
  cleanup: () => void;
}

function startHarness(config: FakeStackOverflowConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeStackOverflow(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "stackoverflow"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        stackoverflow: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function question(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Question ${String(id)} — exponential backoff with jitter`,
    body: "<p>thundering-herd retries on the payment queue</p>",
    bodyMarkdown: "thundering-herd retries on the payment queue",
    tags: [{ name: "reliability" }],
    score: 3,
    viewCount: 42,
    answerCount: 1,
    isAnswered: true,
    owner: { id: 7, name: "Ada Lovelace" },
    webUrl: `https://stackoverflowteams.com/c/acme/questions/${String(id)}`,
    creationDate: "2024-03-01T12:00:00.000Z",
    lastActivityDate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

function fullPage(base: number): unknown[] {
  return Array.from({ length: 100 }, (_, i) => question(base + i));
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.stackoverflowteams.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("stackoverflow-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with stackoverflow:<id> ids + Bearer auth + team-slug-in-path", async () => {
    h = startHarness({ pages: [[question(1), question(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "so_test_token");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);

    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("pagesize=100");
    expect(reqs[0]?.query).toContain("page=1");
    expect(reqs[0]?.query).toContain("sort=creation");
    expect(expectedPath).toContain("%20");
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer so_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'stackoverflow' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["stackoverflow:1", "stackoverflow:2"]);
  });

  test("page-number walk: continues while page < totalPages, stops at the last page", async () => {
    h = startHarness({ pages: [fullPage(1), [question(1000)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => fullPage(i * 100 + 1));
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
    const reqs = h.fake.requests.filter((r) => r.path === expectedPath);
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20 * 100);
  });

  test("the webUrl is the canonical url; missing-webUrl questions → null", async () => {
    h = startHarness({ pages: [[question(1), question(2, { webUrl: null })]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);

    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'stackoverflow' AND external_id = '1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://stackoverflowteams.com/c/acme/questions/1");
    const noUrl = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'stackoverflow' AND external_id = '2'",
      )
      .get();
    expect(noUrl?.canonical_url).toBeNull();
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: [[question(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when team unset — no requests (both keys required)", async () => {
    h = startHarness({ pages: [[question(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty question list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("stackoverflow.token", "k");
    await h.vault.set("stackoverflow.team", TEAM);
    const syncable = createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);
  });
});
