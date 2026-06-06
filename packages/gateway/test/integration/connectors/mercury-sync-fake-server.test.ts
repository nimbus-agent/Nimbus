import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createMercurySyncable } from "../../../src/connectors/mercury-sync.ts";
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

interface FakeMercuryConfig {
  accounts?: unknown[];
  status?: number;
  badJson?: boolean;
}

interface FakeMercury {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeMercury(config: FakeMercuryConfig): FakeMercury {
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
      if (u.pathname === "/api/v1/accounts") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        return Response.json({ accounts: config.accounts ?? [] });
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
  fake: FakeMercury;
  cleanup: () => void;
}

function startHarness(config: FakeMercuryConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeMercury(config);
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
      rateLimiter: new ProviderRateLimiter({
        mercury: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function account(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Account ${id}`,
    status: "active",
    type: "mercury",
    kind: "checking",
    accountNumber: "9876543210",
    routingNumber: "021000021",
    availableBalance: 12345.67,
    currentBalance: 12300,
    legalBusinessName: "Acme Inc",
    createdAt: "2024-03-01T12:00:00.000Z",
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const rewritten = urlStr.replace("https://api.mercury.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("mercury-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single GET → upserts with mercury:<id> ids + Bearer auth", async () => {
    h = startHarness({ accounts: [account("a1"), account("a2")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("mercury.token", "mercury_test_token");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v1/accounts");
    expect(reqs).toHaveLength(1);
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer mercury_test_token");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'mercury' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["a1", "a2"]);
    expect(rows.map((r) => r.id)).toEqual(["mercury:a1", "mercury:a2"]);
  });

  test("the full account number is never persisted (last-4 only)", async () => {
    h = startHarness({ accounts: [account("a1")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("mercury.token", "k");

    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);

    const row = h.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'mercury' AND external_id = 'a1'",
      )
      .get();
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.metadata).not.toContain("9876543210");
    expect(row.metadata).toContain("3210");
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ accounts: [account("a1")] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty account list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ accounts: [] });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
  });

  test("5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
  });

  test("parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.ctx.vault.set("mercury.token", "k");
    const syncable = createMercurySyncable({ ensureMercuryMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-mercury1:")).toBe(true);
  });
});
