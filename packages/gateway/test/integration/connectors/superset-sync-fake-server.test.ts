import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createSupersetSyncable } from "../../../src/connectors/superset-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  page: string | null;
}

interface FakeSupersetConfig {
  dashboards: unknown[];
  loginStatus?: number;
  loginAccessToken?: string | null;
  dashboardsStatus?: number;
}

interface FakeSuperset {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function pageFromRison(q: string | null): string | null {
  if (q === null) {
    return null;
  }
  const m = /page:(\d+)/.exec(q);
  return m?.[1] ?? null;
}

function startFakeSuperset(config: FakeSupersetConfig): FakeSuperset {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        page: pageFromRison(u.searchParams.get("q")),
      });
      if (u.pathname === "/api/v1/security/login") {
        await req.text();
        if (config.loginStatus !== undefined && config.loginStatus !== 200) {
          return new Response("login error", { status: config.loginStatus });
        }
        const token = config.loginAccessToken === undefined ? "tok" : config.loginAccessToken;
        return Response.json(token === null ? {} : { access_token: token });
      }
      if (u.pathname === "/api/v1/dashboard/") {
        if (config.dashboardsStatus !== undefined && config.dashboardsStatus !== 200) {
          return new Response("error", { status: config.dashboardsStatus });
        }
        const page = Number.parseInt(pageFromRison(u.searchParams.get("q")) ?? "0", 10);
        const PAGE_SIZE = 100;
        const slice = config.dashboards.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
        return Response.json({ result: slice, count: config.dashboards.length });
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
  fake: FakeSuperset;
  cleanup: () => void;
}

function startHarness(config: FakeSupersetConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeSuperset(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "superset"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        superset: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function dashboard(
  id: number,
  over: { dashboard_title?: string; slug?: string } = {},
): Record<string, unknown> {
  return {
    id,
    dashboard_title: over.dashboard_title ?? `dash-${String(id)}`,
    slug: over.slug ?? `dash-${String(id)}`,
    published: true,
    status: "published",
    owners: [{ id: 1 }],
    changed_by: { first_name: "Ada", last_name: "Lovelace" },
    changed_on_utc: "2022-06-01T08:00:00.000000+0000",
  };
}

async function seedCreds(h: Harness): Promise<void> {
  await h.vault.set("superset.url", h.fake.baseUrl);
  await h.vault.set("superset.username", "reader");
  await h.vault.set("superset.password", "pw");
}

describe("superset-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: logs in, then lists dashboards with Bearer, upserts rows", async () => {
    h = startHarness({
      dashboards: [
        dashboard(10, { dashboard_title: "Revenue" }),
        dashboard(20, { dashboard_title: "Funnel" }),
      ],
    });
    await seedCreds(h);

    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-superset1:")).toBe(true);

    const logins = h.fake.requests.filter(
      (r) => r.path === "/api/v1/security/login" && r.method === "POST",
    );
    expect(logins).toHaveLength(1);

    const gets = h.fake.requests.filter((r) => r.path === "/api/v1/dashboard/");
    expect(gets.length).toBeGreaterThanOrEqual(1);
    for (const r of gets) {
      expect(r.auth).toBe("Bearer tok");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'superset' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["10", "20"]);

    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["dashboard_id"]).toBe(10);
    expect(first["title"]).toBe("Revenue");
    expect(first["changed_by"]).toBe("Ada Lovelace");
  });

  test("noop when any of url/username/password unset — no requests", async () => {
    h = startHarness({ dashboards: [dashboard(1)] });
    await h.vault.set("superset.url", h.fake.baseUrl);
    await h.vault.set("superset.username", "reader");
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("login failure (5xx) → graceful empty pass: no throw, zero upserts, no dashboard GET", async () => {
    h = startHarness({ dashboards: [dashboard(1)], loginStatus: 503 });
    await seedCreds(h);
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-superset1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/security/login")).toHaveLength(1);
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/dashboard/")).toHaveLength(0);
  });

  test("login 401 → graceful empty pass (no dashboard GET)", async () => {
    h = startHarness({ dashboards: [dashboard(1)], loginStatus: 401 });
    await seedCreds(h);
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/dashboard/")).toHaveLength(0);
  });

  test("login ok but no access_token → graceful empty pass (no dashboard GET)", async () => {
    h = startHarness({ dashboards: [dashboard(1)], loginAccessToken: null });
    await seedCreds(h);
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/dashboard/")).toHaveLength(0);
  });

  test("a 5xx on the dashboards page degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ dashboards: [dashboard(1)], dashboardsStatus: 503 });
    await seedCreds(h);
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-superset1:")).toBe(true);
  });

  test("a full page of exactly 100 dashboards triggers a second page (page:1)", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => dashboard(i + 1));
    const extra = [dashboard(101)];
    h = startHarness({ dashboards: [...fullPage, ...extra] });
    await seedCreds(h);
    const syncable = createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(101);
    const gets = h.fake.requests.filter((r) => r.path === "/api/v1/dashboard/");
    expect(gets.length).toBeGreaterThanOrEqual(2);
    expect(gets[0]?.page).toBe("0");
    expect(gets[1]?.page).toBe("1");
  });
});
