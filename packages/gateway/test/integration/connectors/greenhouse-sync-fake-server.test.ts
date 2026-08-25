import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createGreenhouseSyncable } from "../../../src/connectors/greenhouse-sync.ts";
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

interface FakeGreenhouseConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeGreenhouse {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeGreenhouse(config: FakeGreenhouseConfig): FakeGreenhouse {
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
      if (u.pathname === "/v1/jobs") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const page = Number(u.searchParams.get("page") ?? "1");
        const data = pages[page - 1] ?? [];
        return Response.json(data);
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
  fake: FakeGreenhouse;
  cleanup: () => void;
}

function startHarness(config: FakeGreenhouseConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeGreenhouse(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "greenhouse"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        greenhouse: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function job(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Senior Backend Engineer ${String(id)}`,
    status: "open",
    requisition_id: "ENG-1",
    confidential: false,
    departments: [{ id: 1, name: "Engineering" }],
    offices: [{ id: 10, name: "SF HQ", location: { name: "San Francisco, CA" } }],
    opened_at: "2024-03-01T12:30:00.000Z",
    created_at: "2024-03-01T12:00:00.000Z",
    updated_at: "2024-03-02T12:00:00.000Z",
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://harvest.greenhouse.io", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("greenhouse-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with greenhouse:<id> ids + Basic (key-as-username) auth", async () => {
    h = startHarness({ pages: [[job(4001), job(4002)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "greenhouse_api_key_secret");

    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-greenhouse1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/v1/jobs");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("per_page=100");
    const expected = `Basic ${Buffer.from("greenhouse_api_key_secret:", "utf8").toString("base64")}`;
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe(expected);
      expect(r.authorization).not.toContain("greenhouse_api_key_secret");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'greenhouse' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["4001", "4002"]);
    expect(rows.map((r) => r.id)).toEqual(["greenhouse:4001", "greenhouse:4002"]);
  });

  test("bare-array page-number walk: follows full pages until a short page", async () => {
    const full1 = Array.from({ length: 100 }, (_, i) => job(1000 + i));
    const full2 = Array.from({ length: 100 }, (_, i) => job(2000 + i));
    h = startHarness({ pages: [full1, full2, [job(3000)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");

    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(201);
    const reqs = h.fake.requests.filter((r) => r.path === "/v1/jobs");
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("page"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => job(p * 100 + i)),
    );
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");

    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/v1/jobs");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(2000);
  });

  test("canonical_url is always null (no per-job public URL)", async () => {
    h = startHarness({ pages: [[job(4001)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");

    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'greenhouse' AND external_id = '4001'",
      )
      .get();
    expect(row?.canonical_url).toBeNull();
  });

  test("missing-id / non-numeric-id rows are skipped", async () => {
    const noId = job(0);
    delete noId["id"];
    const stringId = job(0, { id: "abc" });
    h = startHarness({ pages: [[job(4001), noId, stringId]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");

    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });

  test("noop when api_key unset — no requests", async () => {
    h = startHarness({ pages: [[job(4001)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty job list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");
    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-greenhouse1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");
    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-greenhouse1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("greenhouse.api_key", "k");
    const syncable = createGreenhouseSyncable({ ensureGreenhouseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-greenhouse1:")).toBe(true);
  });
});
