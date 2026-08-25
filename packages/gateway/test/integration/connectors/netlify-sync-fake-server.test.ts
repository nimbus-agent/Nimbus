import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createNetlifySyncable } from "../../../src/connectors/netlify-sync.ts";
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

interface FakeNetlifyConfig {
  pages?: Record<string, unknown[]>;
  status?: number;
  badJson?: boolean;
}

interface FakeNetlify {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeNetlify(config: FakeNetlifyConfig): FakeNetlify {
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
      if (u.pathname === "/api/v1/sites") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const page = u.searchParams.get("page") ?? "1";
        const sites = config.pages?.[page] ?? [];
        return Response.json(sites);
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
  fake: FakeNetlify;
  cleanup: () => void;
}

function startHarness(config: FakeNetlifyConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeNetlify(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "netlify"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        netlify: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function site(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `app-${id}`,
    url: `http://app-${id}.netlify.app`,
    admin_url: `https://app.netlify.com/sites/app-${id}`,
    ssl_url: `https://app-${id}.netlify.app`,
    account_name: "Acme Inc",
    created_at: "2024-01-15T08:30:00.000Z",
    updated_at: "2024-03-01T12:00:00.000Z",
    build_settings: { repo_url: "https://github.com/acme/app", repo_branch: "main" },
    published_deploy: { id: `deploy_${id}`, state: "ready", branch: "main", title: `deploy ${id}` },
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.netlify.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function fullPage(prefix: string): unknown[] {
  return Array.from({ length: 100 }, (_, i) => site(`${prefix}_${String(i)}`));
}

describe("netlify-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single short page → upserts with netlify:<id> ids + Bearer auth", async () => {
    h = startHarness({ pages: { "1": [site("s1"), site("s2")] } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "nf-test-token");

    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-netlify1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer nf-test-token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'netlify' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["s1", "s2"]);
    expect(rows.map((r) => r.id)).toEqual(["netlify:s1", "netlify:s2"]);
  });

  test("multi-page pagination: a full page then a short page stops the walk", async () => {
    h = startHarness({ pages: { "1": fullPage("a"), "2": [site("b1")] } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "t");

    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(101);
    const reqs = h.fake.requests.filter((r) => r.path === "/api/v1/sites");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.query).toContain("page=1");
    expect(reqs[1]?.query).toContain("page=2");
  });

  test("MAX_PAGES cap: perpetual full pages stop after 20 pages", async () => {
    h = startHarness({});
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "t");

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
        const sites = Array.from({ length: 100 }, () => {
          serial += 1;
          return site(`s_${String(serial)}`);
        });
        return Response.json(sites);
      },
    });
    const fakeBase = `http://${server.hostname}:${server.port}`;
    restoreFetch?.();
    restoreFetch = withRewrittenFetch(fakeBase);

    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(requests.filter((r) => r.path === "/api/v1/sites")).toHaveLength(20);
    expect(result.itemsUpserted).toBe(2000);
    server.stop(true);
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: { "1": [site("s1")] } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty sites list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: { "1": [] } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "t");
    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-netlify1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "t");
    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-netlify1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("netlify.token", "t");
    const syncable = createNetlifySyncable({ ensureNetlifyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-netlify1:")).toBe(true);
  });
});
