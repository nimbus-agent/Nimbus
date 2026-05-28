import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createLeverSyncable } from "../../../src/connectors/lever-sync.ts";
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

interface FakeLeverConfig {
  /** Pages of postings, in order. Each entry becomes one `data` page. */
  pages?: unknown[][];
  status?: number;
  /** When true, the postings route returns invalid JSON. */
  badJson?: boolean;
}

interface FakeLever {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeLever(config: FakeLeverConfig): FakeLever {
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
      if (u.pathname === "/v1/postings") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        // Lever offset cursor: the `offset` query param is the page index
        // (0 when absent). The `next` value we return is the next index.
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const data = pages[offset] ?? [];
        const hasNext = offset + 1 < pages.length;
        return Response.json({
          data,
          hasNext,
          next: hasNext ? String(offset + 1) : undefined,
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
  fake: FakeLever;
  cleanup: () => void;
}

function startHarness(config: FakeLeverConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeLever(config);
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
      // Use a very high burst so the rate limiter never sleeps in tests.
      rateLimiter: new ProviderRateLimiter({
        lever: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function posting(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    text: `Senior Backend Engineer ${id}`,
    state: "published",
    categories: {
      team: "Engineering",
      department: "Product",
      location: "Remote",
      commitment: "Full-time",
      level: "Senior",
    },
    tags: ["backend"],
    hostedUrl: "https://jobs.lever.co/acme/posting",
    applyUrl: "https://jobs.lever.co/acme/posting/apply",
    reqCode: "ENG-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    ...over,
  };
}

// The fake fakes api.lever.co, but the sync handler hardcodes the SaaS base.
// We override the global fetch to rewrite api.lever.co → the fake server.
function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const rewritten = urlStr.replace("https://api.lever.co", fakeBase);
    return original(rewritten, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("lever-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with lever:<id> ids + Basic (key-as-username) auth", async () => {
    h = startHarness({ pages: [[posting("uuid-1"), posting("uuid-2")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "lever_api_key_secret");

    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-lever1:")).toBe(true);

    // Single page (hasNext false) → the walk stopped after one GET.
    const reqs = h.fake.requests.filter((r) => r.path === "/v1/postings");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("limit=100");
    // The Basic auth header is base64(<api_key>:) — the key as username, empty
    // password. The raw key never appears in the header.
    const expected = `Basic ${Buffer.from("lever_api_key_secret:", "utf8").toString("base64")}`;
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe(expected);
      expect(r.authorization).not.toContain("lever_api_key_secret");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'lever' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["uuid-1", "uuid-2"]);
    expect(rows.map((r) => r.id)).toEqual(["lever:uuid-1", "lever:uuid-2"]);
  });

  test("hasNext/next offset-cursor walk: follows next across pages", async () => {
    // page 0 hasNext → page 1 hasNext → page 2 last.
    h = startHarness({
      pages: [[posting("a")], [posting("b")], [posting("c")]],
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");

    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    const reqs = h.fake.requests.filter((r) => r.path === "/v1/postings");
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("offset"))).toEqual([
      null,
      "1",
      "2",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    // 25 single-item pages, each with hasNext → the cap (20) stops it.
    const pages = Array.from({ length: 25 }, (_, i) => [posting(`id-${String(i)}`)]);
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");

    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/v1/postings");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20);
  });

  test("the hostedUrl is the canonical url; missing-url postings → null", async () => {
    const noUrl = posting("uuid-2", {});
    delete (noUrl as Record<string, unknown>)["hostedUrl"];
    delete (noUrl as Record<string, unknown>)["applyUrl"];
    h = startHarness({ pages: [[posting("uuid-1"), noUrl]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");

    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const web = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'lever' AND external_id = 'uuid-1'",
      )
      .get();
    expect(web?.canonical_url).toBe("https://jobs.lever.co/acme/posting");
    const none = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'lever' AND external_id = 'uuid-2'",
      )
      .get();
    expect(none?.canonical_url).toBeNull();
  });

  test("missing-id rows are skipped", async () => {
    const noId = posting("");
    delete (noId as Record<string, unknown>)["id"];
    h = startHarness({ pages: [[posting("uuid-1"), noId]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");

    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });

  test("noop when api_key unset — no requests", async () => {
    h = startHarness({ pages: [[posting("uuid-1")]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty posting list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");
    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-lever1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");
    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-lever1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("lever.api_key", "k");
    const syncable = createLeverSyncable({ ensureLeverMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-lever1:")).toBe(true);
  });
});
