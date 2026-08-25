import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createPipedriveSyncable } from "../../../src/connectors/pipedrive-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const TOKEN = "pipedrive_super_secret_token_abc123";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  url: string;
}

interface FakePipedriveConfig {
  pages?: unknown[][];
  nullData?: boolean;
  status?: number;
  badJson?: boolean;
}

interface FakePipedrive {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakePipedrive(config: FakePipedriveConfig): FakePipedrive {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname, query: u.search, url: req.url });
      if (u.pathname === "/v1/deals") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response(JSON.stringify({ success: false, error: "server error" }), {
            status: config.status,
          });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const start = Number(u.searchParams.get("start") ?? "0");
        const pageIndex = start / 100;
        const data = config.nullData === true ? null : (pages[pageIndex] ?? []);
        const moreItems = pageIndex + 1 < pages.length;
        return Response.json({
          success: true,
          data,
          additional_data: {
            pagination: {
              start,
              limit: 100,
              more_items_in_collection: moreItems,
              ...(moreItems ? { next_start: (pageIndex + 1) * 100 } : {}),
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface CapturedLog {
  level: number;
  msg?: string;
  raw: string;
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakePipedrive;
  logs: CapturedLog[];
  cleanup: () => void;
}

function startHarness(config: FakePipedriveConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakePipedrive(config);
  const logs: CapturedLog[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write: (line: string) => {
        try {
          const parsed = JSON.parse(line) as { level: number; msg?: string };
          logs.push({ level: parsed.level, msg: parsed.msg, raw: line });
        } catch {
          logs.push({ level: 0, raw: line });
        }
      },
    },
  );
  return {
    db,
    vault,
    fake,
    logs,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "pipedrive"),
      logger,
      rateLimiter: new ProviderRateLimiter({
        pipedrive: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function deal(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Deal ${String(id)} — Acme renewal`,
    value: 48000,
    currency: "USD",
    status: "open",
    stage_id: 3,
    pipeline_id: 1,
    person_id: 777,
    person_name: "Jane Roe",
    org_id: 999,
    org_name: "Acme Corporation",
    owner_name: "Sam Seller",
    probability: 80,
    label: "hot-lead",
    add_time: "2024-01-15 10:30:00",
    update_time: "2024-02-01 08:00:00",
    won_time: null,
    close_time: null,
    ...over,
  };
}

function fullPage(base: number): unknown[] {
  return Array.from({ length: 100 }, (_, i) => deal(base + i));
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.pipedrive.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("pipedrive-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single short page → upserts with pipedrive:<id> ids + token in query string", async () => {
    h = startHarness({ pages: [[deal(1), deal(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-pipedrive1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/v1/deals");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("limit=100");
    expect(reqs[0]?.query).toContain("start=0");
    expect(reqs[0]?.query).toContain(`api_token=${TOKEN}`);

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'pipedrive' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["pipedrive:1", "pipedrive:2"]);
  });

  test("offset walk: continues while more_items_in_collection is true, follows next_start", async () => {
    h = startHarness({ pages: [fullPage(1), [deal(1000)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const reqs = h.fake.requests.filter((r) => r.path === "/v1/deals");
    expect(reqs.map((r) => new URL(`https://x${r.query}`).searchParams.get("start"))).toEqual([
      "0",
      "100",
    ]);
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => fullPage(i * 100 + 1));
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/v1/deals");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20 * 100);
  });

  test("null `data` → zero upserts, pass-1 cursor (Pipedrive returns null for empty)", async () => {
    h = startHarness({ nullData: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-pipedrive1:")).toBe(true);
  });

  test("the canonical url is always null", async () => {
    h = startHarness({ pages: [[deal(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ canonical_url: string | null }, []>(
        "SELECT canonical_url FROM item WHERE service = 'pipedrive' AND external_id = '1'",
      )
      .get();
    expect(row?.canonical_url).toBeNull();
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: [[deal(1)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty deal list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);
    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-pipedrive1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);
    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-pipedrive1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully AND never leaks the token in logs/result", async () => {
    h = startHarness({ status: 500 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-pipedrive1:")).toBe(true);

    expect(h.logs.some((l) => l.msg === "pipedrive GET failed")).toBe(true);
    for (const log of h.logs) {
      expect(log.raw.includes(TOKEN)).toBe(false);
    }
    expect(JSON.stringify(result).includes(TOKEN)).toBe(false);
  });

  test("the token never appears in any upserted item row or metadata", async () => {
    h = startHarness({ pages: [[deal(1), deal(2)]] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("pipedrive.token", TOKEN);

    const syncable = createPipedriveSyncable({ ensurePipedriveMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const rows = h.db
      .query<Record<string, unknown>, []>("SELECT * FROM item WHERE service = 'pipedrive'")
      .all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row).includes(TOKEN)).toBe(false);
    }
  });
});
