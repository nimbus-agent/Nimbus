import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createVercelSyncable } from "../../../src/connectors/vercel-sync.ts";
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

interface DeploymentsPage {
  deployments: unknown[];
  next?: number | null;
}

interface FakeVercelConfig {
  pages?: Record<string, DeploymentsPage>;
  status?: number;
  badJson?: boolean;
}

interface FakeVercel {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeVercel(config: FakeVercelConfig): FakeVercel {
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
      if (u.pathname === "/v6/deployments") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const until = u.searchParams.get("until") ?? "";
        const page = config.pages?.[until] ?? { deployments: [] };
        const body: Record<string, unknown> = { deployments: page.deployments };
        body["pagination"] = { count: page.deployments.length, next: page.next ?? null };
        return Response.json(body);
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
  fake: FakeVercel;
  cleanup: () => void;
}

function startHarness(config: FakeVercelConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeVercel(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "vercel"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        vercel: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function deployment(uid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid,
    name: "my-app",
    url: `${uid}.vercel.app`,
    created: 1_700_000_000_000,
    state: "READY",
    readyState: "READY",
    target: "production",
    inspectorUrl: `https://vercel.com/acme/my-app/${uid}`,
    creator: { uid: "u1", username: "alice" },
    meta: { githubCommitSha: "abc123", githubCommitMessage: `deploy ${uid}` },
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.vercel.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("vercel-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with vercel:<uid> ids + Bearer auth", async () => {
    h = startHarness({
      pages: { "": { deployments: [deployment("dpl_1"), deployment("dpl_2")], next: null } },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "vc-test-token");

    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-vercel1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer vc-test-token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'vercel' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["dpl_1", "dpl_2"]);
    expect(rows.map((r) => r.id)).toEqual(["vercel:dpl_1", "vercel:dpl_2"]);
  });

  test("multi-page pagination: pagination.next drives the next page's until", async () => {
    h = startHarness({
      pages: {
        "": { deployments: [deployment("dpl_1")], next: 1_699_000_000_000 },
        "1699000000000": { deployments: [deployment("dpl_2")], next: null },
      },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");

    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const reqs = h.fake.requests.filter((r) => r.path === "/v6/deployments");
    expect(reqs).toHaveLength(2);
    expect(reqs[1]?.query).toContain("until=1699000000000");
  });

  test("MAX_PAGES cap: a perpetual next stops after 20 pages", async () => {
    const pages: Record<string, DeploymentsPage> = {};
    h = startHarness({ pages });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");

    h.fake.stop();
    let counter = 0;
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
        counter += 1;
        return Response.json({
          deployments: [deployment(`dpl_${String(counter)}`)],
          pagination: { count: 1, next: 1_700_000_000_000 - counter },
        });
      },
    });
    const fakeBase = `http://${server.hostname}:${server.port}`;
    restoreFetch?.();
    restoreFetch = withRewrittenFetch(fakeBase);

    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(requests.filter((r) => r.path === "/v6/deployments")).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20);
    server.stop(true);
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: { "": { deployments: [deployment("dpl_1")] } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty deployments page → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: { "": { deployments: [], next: null } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");
    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-vercel1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");
    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-vercel1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");
    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-vercel1:")).toBe(true);
  });

  test("teamId passthrough: when vercel.team_id is set the query carries teamId=", async () => {
    h = startHarness({
      pages: { "": { deployments: [deployment("dpl_1")], next: null } },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("vercel.token", "t");
    await h.vault.set("vercel.team_id", "team_xyz");

    const syncable = createVercelSyncable({ ensureVercelMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/v6/deployments");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("teamId=team_xyz");
  });
});
