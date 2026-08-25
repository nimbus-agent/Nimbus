import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createDependencytrackSyncable } from "../../../src/connectors/dependencytrack-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  pageNumber: string | null;
  apiKey: string | null;
}

interface FakeDtConfig {
  // Map of pageNumber -> projects array for that page.
  pages?: Record<string, unknown[]>;
  status?: number;
}

interface FakeDt {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeDt(config: FakeDtConfig): FakeDt {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      const pageNumber = u.searchParams.get("pageNumber");
      requests.push({
        method: req.method,
        path: u.pathname,
        pageNumber,
        apiKey: req.headers.get("x-api-key"),
      });
      if (u.pathname !== "/api/v1/project") {
        return new Response("not found", { status: 404 });
      }
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const page = pageNumber ?? "1";
      return Response.json(config.pages?.[page] ?? []);
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeDt;
  cleanup: () => void;
}

function startHarness(config: FakeDtConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeDt(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "dependencytrack"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        dependencytrack: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function project(
  uuid: string,
  over: { name?: string; version?: string; metrics?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    uuid,
    name: over.name ?? `proj-${uuid}`,
    version: over.version ?? "1.0.0",
    classifier: "APPLICATION",
    active: true,
    lastBomImport: 1_700_000_000_000,
    tags: [{ name: "tier-1" }],
    metrics: over.metrics ?? { critical: 1, high: 2, vulnerabilities: 5, components: 30 },
  };
}

// 100 distinct projects — a full page that triggers a second page fetch.
function fullPage(prefix: string): unknown[] {
  return Array.from({ length: 100 }, (_, i) => project(`${prefix}-${String(i)}`));
}

describe("dependencytrack-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: lists projects, upserts rows with X-Api-Key, pass-1 cursor", async () => {
    h = startHarness({
      pages: {
        "1": [
          project("u-10", { name: "payment-service", version: "2.3.1" }),
          project("u-20", { name: "checkout", version: "0.9.0" }),
        ],
      },
    });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "dt-key-test");

    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-dependencytrack1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.apiKey).toBe("dt-key-test");
      expect(r.path).toBe("/api/v1/project");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'dependencytrack' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["u-10", "u-20"]);

    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["name"]).toBe("payment-service");
    expect(first["critical"]).toBe(1);
    expect(first["vulnerabilities"]).toBe(5);
  });

  test("walks multiple pages: a full first page triggers a second fetch", async () => {
    h = startHarness({
      pages: {
        "1": fullPage("a"),
        "2": [project("b-0"), project("b-1")],
      },
    });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "k");

    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(102);
    const pageNumbers = h.fake.requests.map((r) => r.pageNumber);
    expect(pageNumbers).toEqual(["1", "2"]);
  });

  test("noop when base_url + api_key unset — no requests", async () => {
    h = startHarness({ pages: { "1": [project("u-1")] } });
    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on page 1 degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ pages: { "1": [project("u-1")] }, status: 429 });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "k");
    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-dependencytrack1:")).toBe(true);
  });

  test("a 401 (auth failure) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "1": [project("u-1")] }, status: 401 });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "bad-key");
    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dependencytrack1:")).toBe(true);
  });

  test("a 403 (forbidden) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "1": [project("u-1")] }, status: 403 });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "k");
    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dependencytrack1:")).toBe(true);
  });

  test("empty first page yields zero upserts and pass-1 cursor", async () => {
    h = startHarness({ pages: { "1": [] } });
    await h.vault.set("dependencytrack.base_url", h.fake.baseUrl);
    await h.vault.set("dependencytrack.api_key", "k");
    const syncable = createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: async () => {},
    });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dependencytrack1:")).toBe(true);
    // Only one request — a short page stops the walk.
    expect(h.fake.requests).toHaveLength(1);
  });
});
