import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import {
  createUnleashSyncable,
  UNLEASH_MAX_FEATURES_PER_PROJECT,
} from "../../../src/connectors/unleash-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  path: string;
  auth: string | null;
}

interface FakeConfig {
  projects: Array<{ id: string; name: string }>;
  featuresByProject: Record<string, unknown[]>;
  projectsStatus?: number;
  failProject?: string;
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  /** `http://127.0.0.1:<port>`: plain http is accepted for a loopback host, as by the connector. */
  base: string;
  requests: RecordedReq[];
  cleanup: () => void;
}

function startHarness(config: FakeConfig, prefix = ""): Harness {
  const requests: RecordedReq[] = [];
  const server: Server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({ path: u.pathname, auth: req.headers.get("authorization") });
      if (u.pathname === `${prefix}/api/admin/projects`) {
        if (config.projectsStatus !== undefined) {
          return new Response("error", { status: config.projectsStatus });
        }
        return Response.json({ version: 1, projects: config.projects });
      }
      const m = new RegExp(`^${prefix}/api/admin/projects/([^/]+)/features$`).exec(u.pathname);
      if (m !== null) {
        const id = decodeURIComponent(m[1] ?? "");
        if (id === config.failProject) return new Response("boom", { status: 500 });
        return Response.json({ version: 2, features: config.featuresByProject[id] ?? [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  return {
    vault,
    db,
    base: `http://127.0.0.1:${String(server.port)}`,
    requests,
    cleanup: () => {
      server.stop(true);
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "unleash"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        unleash: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function feature(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    type: "release",
    description: `Feature ${name}`,
    project: "web",
    stale: false,
    createdAt: "2026-01-02T03:04:05.000Z",
    environments: [{ name: "production", enabled: true }],
    tags: [{ type: "simple", value: "checkout" }],
    ...over,
  };
}

function rows(db: Database): Array<{ external_id: string; metadata: string; url: string | null }> {
  return db
    .query<{ external_id: string; metadata: string; url: string | null }, []>(
      "SELECT external_id, metadata, url FROM item WHERE service = 'unleash' ORDER BY external_id",
    )
    .all();
}

const syncable = () => createUnleashSyncable({ ensureUnleashMcpRunning: async () => {} });

describe("unleash-sync against a Bun.serve fake Admin API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks projects then features, with the bare token, and indexes definitions only", async () => {
    h = startHarness({
      projects: [
        { id: "web", name: "Web" },
        { id: "api", name: "API" },
      ],
      featuresByProject: {
        web: [feature("new_checkout"), feature("dark_mode", { stale: true })],
        api: [feature("rate_limit")],
      },
    });
    await h.vault.set("unleash.api_url", `${h.base}/`);
    await h.vault.set("unleash.token", "fake-unleash-token");
    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.cursor?.startsWith("nimbus-unleash1:")).toBe(true);
    for (const r of h.requests) expect(r.auth).toBe("fake-unleash-token");
    expect(h.requests.map((r) => r.path)).toEqual([
      "/api/admin/projects",
      "/api/admin/projects/web/features",
      "/api/admin/projects/api/features",
    ]);
    const got = rows(h.db);
    expect(got.map((r) => r.external_id)).toEqual([
      "api:rate_limit",
      "web:dark_mode",
      "web:new_checkout",
    ]);
    const m = JSON.parse(got[2]?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["project_name"]).toBe("Web");
    expect(m["tags"]).toEqual(["simple:checkout"]);
    expect(m["created_at"]).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    // Per-environment state is a live read, never indexed.
    expect(JSON.stringify(m)).not.toContain("production");
    expect(got[2]?.url).toBe(`${h.base}/projects/web/features/new_checkout`);
    expect(JSON.parse(got[1]?.metadata ?? "{}")["stale"]).toBe(true);
  });

  test("a sub-path install with a trailing /api is kept and not doubled", async () => {
    h = startHarness(
      { projects: [{ id: "web", name: "Web" }], featuresByProject: { web: [] } },
      "/unleash",
    );
    await h.vault.set("unleash.api_url", `${h.base}/unleash/api`);
    await h.vault.set("unleash.token", "fake-unleash-token");
    await syncable().sync(h.ctx, null);
    expect(h.requests.map((r) => r.path)).toEqual([
      "/unleash/api/admin/projects",
      "/unleash/api/admin/projects/web/features",
    ]);
  });

  test("a project that fails is skipped; the others are indexed", async () => {
    h = startHarness({
      projects: [
        { id: "bad", name: "Bad" },
        { id: "web", name: "Web" },
      ],
      featuresByProject: { web: [feature("a")] },
      failProject: "bad",
    });
    await h.vault.set("unleash.api_url", h.base);
    await h.vault.set("unleash.token", "fake-unleash-token");
    const result = await syncable().sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });

  test("the features of one project are capped", async () => {
    const many = Array.from({ length: UNLEASH_MAX_FEATURES_PER_PROJECT + 5 }, (_, i) =>
      feature(`f${String(i)}`),
    );
    h = startHarness({ projects: [{ id: "web", name: "Web" }], featuresByProject: { web: many } });
    await h.vault.set("unleash.api_url", h.base);
    await h.vault.set("unleash.token", "fake-unleash-token");
    const result = await syncable().sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(UNLEASH_MAX_FEATURES_PER_PROJECT);
  });

  test("an error on the project list upserts nothing and keeps a pass-1 cursor", async () => {
    h = startHarness({ projects: [], featuresByProject: {}, projectsStatus: 401 });
    await h.vault.set("unleash.api_url", h.base);
    await h.vault.set("unleash.token", "fake-unleash-token");
    const result = await syncable().sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-unleash1:")).toBe(true);
  });

  test("no request without both the URL and the token, or with a URL the connector would refuse", async () => {
    h = startHarness({ projects: [], featuresByProject: {} });
    await h.vault.set("unleash.token", "fake-unleash-token");
    expect((await syncable().sync(h.ctx, "c")).cursor).toBe("c");
    // Plain http to a host that is not loopback: the token would travel in clear text.
    await h.vault.set("unleash.api_url", "http://unleash.example.com");
    expect((await syncable().sync(h.ctx, null)).itemsUpserted).toBe(0);
    expect(h.requests).toHaveLength(0);
  });
});
