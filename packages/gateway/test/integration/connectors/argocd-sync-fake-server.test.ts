import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createArgocdSyncable } from "../../../src/connectors/argocd-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeAgConfig {
  applications: unknown[];
  applicationsStatus?: number;
}

interface FakeAg {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeAg(config: FakeAgConfig): FakeAg {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        search: u.searchParams,
      });
      if (u.pathname === "/api/v1/applications") {
        if (config.applicationsStatus !== undefined && config.applicationsStatus !== 200) {
          return new Response("error", { status: config.applicationsStatus });
        }
        return Response.json({ items: config.applications });
      }
      const getMatch = /^\/api\/v1\/applications\/([^/]+)$/.exec(u.pathname);
      if (getMatch !== null) {
        const name = decodeURIComponent(getMatch[1] ?? "");
        const app = config.applications.find(
          (a) =>
            a !== null &&
            typeof a === "object" &&
            ((a as { metadata?: { name?: unknown } }).metadata?.name ?? undefined) === name,
        );
        if (app === undefined) {
          return new Response("not found", { status: 404 });
        }
        return Response.json(app);
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
  fake: FakeAg;
  cleanup: () => void;
}

function startHarness(config: FakeAgConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeAg(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "argocd"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        argocd: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function app(
  name: string,
  over: {
    project?: string;
    repoURL?: string;
    sync?: string;
    health?: string;
    status?: Record<string, unknown> | null;
    spec?: Record<string, unknown> | null;
  } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    metadata: { name, namespace: "argocd", creationTimestamp: "2021-02-10T20:03:11Z" },
  };
  if (over.spec !== null) {
    base["spec"] = over.spec ?? {
      project: over.project ?? "default",
      source: { repoURL: over.repoURL ?? "https://github.com/acme/app", path: "k8s" },
      destination: { server: "https://kubernetes.default.svc", namespace: "prod" },
    };
  }
  if (over.status !== null) {
    base["status"] = over.status ?? {
      sync: { status: over.sync ?? "Synced", revision: "rev1" },
      health: { status: over.health ?? "Healthy" },
    };
  }
  return base;
}

describe("argocd-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: lists applications and upserts well-formed rows with Bearer auth", async () => {
    h = startHarness({
      applications: [
        app("payments-api", { project: "team-payments", sync: "Synced", health: "Healthy" }),
        app("billing-api", { project: "team-billing", sync: "OutOfSync", health: "Degraded" }),
      ],
    });
    await h.vault.set("argocd.url", h.fake.baseUrl);
    await h.vault.set("argocd.token", "jwt-test-token");

    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-argocd1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Bearer jwt-test-token");
    }
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/applications")).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'argocd' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["billing-api", "payments-api"]);

    const billing = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(billing["sync_status"]).toBe("OutOfSync");
    expect(billing["health_status"]).toBe("Degraded");
    expect(billing["project"]).toBe("team-billing");
    expect(billing["repo_url"]).toBe("https://github.com/acme/app");
  });

  test("noop when argocd.url set but argocd.token unset — no requests", async () => {
    h = startHarness({ applications: [app("x")] });
    await h.vault.set("argocd.url", h.fake.baseUrl);
    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when argocd.token set but argocd.url unset — no requests", async () => {
    h = startHarness({ applications: [app("x")] });
    await h.vault.set("argocd.token", "tok");
    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 5xx on /applications degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ applications: [app("x")], applicationsStatus: 503 });
    await h.vault.set("argocd.url", h.fake.baseUrl);
    await h.vault.set("argocd.token", "tok");
    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-argocd1:")).toBe(true);
  });

  test("a 429 on /applications degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ applications: [app("x")], applicationsStatus: 429 });
    await h.vault.set("argocd.url", h.fake.baseUrl);
    await h.vault.set("argocd.token", "tok");
    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-argocd1:")).toBe(true);
  });

  test("an application missing status/spec sub-objects still maps (nulls, no throw)", async () => {
    h = startHarness({
      applications: [app("bare-app", { spec: null, status: null })],
    });
    await h.vault.set("argocd.url", h.fake.baseUrl);
    await h.vault.set("argocd.token", "tok");
    const syncable = createArgocdSyncable({ ensureArgocdMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = h.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE external_id = 'bare-app'")
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["sync_status"]).toBeNull();
    expect(m["health_status"]).toBeNull();
    expect(m["project"]).toBeNull();
  });
});
