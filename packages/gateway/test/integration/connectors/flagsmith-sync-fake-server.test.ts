import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createFlagsmithSyncable } from "../../../src/connectors/flagsmith-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeProject {
  id: number;
  name: string;
}

interface FakeFsConfig {
  projects: FakeProject[];
  tagsByProject: Record<string, Array<{ id: number; label: string }>>;
  featuresByProject: Record<string, unknown[]>;
  featuresStatus?: number;
}

interface FakeFs {
  apiBase: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeFs(config: FakeFsConfig): FakeFs {
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
      if (u.pathname === "/api/v1/projects/") {
        return Response.json(config.projects);
      }
      const tagsMatch = /^\/api\/v1\/projects\/([^/]+)\/tags\/$/.exec(u.pathname);
      if (tagsMatch !== null) {
        const projectId = decodeURIComponent(tagsMatch[1] ?? "");
        return Response.json(config.tagsByProject[projectId] ?? []);
      }
      const featuresMatch = /^\/api\/v1\/projects\/([^/]+)\/features\/$/.exec(u.pathname);
      if (featuresMatch !== null) {
        if (config.featuresStatus !== undefined && config.featuresStatus !== 200) {
          return new Response("error", { status: config.featuresStatus });
        }
        const projectId = decodeURIComponent(featuresMatch[1] ?? "");
        const all = config.featuresByProject[projectId] ?? [];
        const pageSize = Number.parseInt(u.searchParams.get("page_size") ?? "100", 10);
        const page = Number.parseInt(u.searchParams.get("page") ?? "1", 10);
        const start = (page - 1) * pageSize;
        const slice = all.slice(start, start + pageSize);
        const hasNext = start + pageSize < all.length;
        return Response.json({
          count: all.length,
          next: hasNext ? `?page=${String(page + 1)}` : null,
          previous: page > 1 ? `?page=${String(page - 1)}` : null,
          results: slice,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const apiBase = `http://${server.hostname}:${server.port}`;
  return { apiBase, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeFs;
  cleanup: () => void;
}

function startHarness(config: FakeFsConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeFs(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://api.flagsmith.com", fake.apiBase);
    return originalFetch(rewritten, init);
  };
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "flagsmith"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        flagsmith: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function feature(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    type: "STANDARD",
    default_enabled: true,
    initial_value: "control",
    description: `Feature ${name}`,
    tags: [],
    is_archived: false,
    owners: [],
    created_date: "2021-02-10T20:03:11.000000Z",
    ...over,
  };
}

describe("flagsmith-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks projects → features and upserts well-formed rows with Token auth", async () => {
    h = startHarness({
      projects: [{ id: 7, name: "payments" }],
      tagsByProject: { "7": [{ id: 1, label: "checkout" }] },
      featuresByProject: {
        "7": [feature("flag-a", { tags: [1] }), feature("flag-b")],
      },
    });
    await h.vault.set("flagsmith.token", "fs-test-token");

    const syncable = createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-flagsmith1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Token fs-test-token");
    }
    expect(h.fake.requests.filter((r) => r.path === "/api/v1/projects/")).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'flagsmith' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["7:flag-a", "7:flag-b"]);
    const a = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(a["project_name"]).toBe("payments");
    expect(a["tags"]).toEqual(["checkout"]);
    expect(a["created_at"]).toBe(Date.parse("2021-02-10T20:03:11.000000Z"));
  });

  test("feature tag ids resolve to labels from the tags endpoint", async () => {
    h = startHarness({
      projects: [{ id: 3, name: "core" }],
      tagsByProject: {
        "3": [
          { id: 10, label: "frontend" },
          { id: 20, label: "billing" },
        ],
      },
      featuresByProject: { "3": [feature("multi", { tags: [20, 10] })] },
    });
    await h.vault.set("flagsmith.token", "tok");
    const syncable = createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE external_id = '3:multi'")
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["tags"]).toEqual(["billing", "frontend"]);
    expect(h.fake.requests.some((r) => r.path === "/api/v1/projects/3/tags/")).toBe(true);
  });

  test("noop when flagsmith.token is unset — no requests", async () => {
    h = startHarness({ projects: [], tagsByProject: {}, featuresByProject: {} });
    const syncable = createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on the features endpoint degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      projects: [{ id: 7, name: "payments" }],
      tagsByProject: { "7": [] },
      featuresByProject: { "7": [feature("flag-a")] },
      featuresStatus: 429,
    });
    await h.vault.set("flagsmith.token", "tok");
    const syncable = createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-flagsmith1:")).toBe(true);
  });

  test("a full first page (results.length === PAGE_SIZE, next set) triggers a second page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => feature(`flag-${String(i)}`));
    const extra = [feature("flag-100")];
    h = startHarness({
      projects: [{ id: 7, name: "payments" }],
      tagsByProject: { "7": [] },
      featuresByProject: { "7": [...fullPage, ...extra] },
    });
    await h.vault.set("flagsmith.token", "tok");
    const syncable = createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(101);
    const featureCalls = h.fake.requests.filter((r) => r.path === "/api/v1/projects/7/features/");
    expect(featureCalls.length).toBeGreaterThanOrEqual(2);
    expect(featureCalls[0]?.search.get("page")).toBe("1");
    expect(featureCalls[1]?.search.get("page")).toBe("2");
  });
});
