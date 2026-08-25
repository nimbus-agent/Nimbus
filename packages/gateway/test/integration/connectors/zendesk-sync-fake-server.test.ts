import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createZendeskSyncable } from "../../../src/connectors/zendesk-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface FakeZendeskConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
}

interface FakeZendesk {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeZendesk(config: FakeZendeskConfig): FakeZendesk {
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
      if (u.pathname === "/api/v2/tickets.json") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const pages = config.pages ?? [[]];
        const after = u.searchParams.get("page[after]");
        const page = after === null ? 0 : Number(after);
        const tickets = pages[page] ?? [];
        const hasMore = page + 1 < pages.length;
        return Response.json({
          tickets,
          meta: { has_more: hasMore, after_cursor: hasMore ? String(page + 1) : null },
          links: { next: hasMore ? `?page[after]=${String(page + 1)}` : null },
        });
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
  fake: FakeZendesk;
  cleanup: () => void;
}

function startHarness(config: FakeZendeskConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeZendesk(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "zendesk"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        zendesk: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function ticket(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    subject: `Ticket ${String(id)} — checkout button unresponsive on Safari`,
    description: "customer reports the checkout button does nothing",
    status: "open",
    priority: "high",
    type: "incident",
    requester_id: 901,
    assignee_id: 42,
    tags: ["checkout"],
    via: { channel: "email" },
    created_at: "2024-03-01T12:00:00Z",
    updated_at: "2024-03-02T08:00:00Z",
    ...over,
  };
}

function fullPage(base: number): unknown[] {
  return Array.from({ length: 100 }, (_, i) => ticket(base + i));
}

async function seedCreds(h: Harness): Promise<void> {
  await h.vault.set("zendesk.url", h.fake.baseUrl);
  await h.vault.set("zendesk.email", "agent@acme.com");
  await h.vault.set("zendesk.api_token", "zd_test_token");
}

describe("zendesk-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with zendesk:<id> ids + Basic auth", async () => {
    h = startHarness({ pages: [[ticket(1), ticket(2)]] });
    await seedCreds(h);

    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-zendesk1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/tickets.json");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.query).toContain("page%5Bsize%5D=100");
    const expected = `Basic ${Buffer.from("agent@acme.com/token:zd_test_token", "utf8").toString("base64")}`;
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe(expected);
      expect(r.authorization?.includes("zd_test_token")).toBe(false);
    }

    const rows = h.db
      .query<{ id: string; external_id: string; canonical_url: string | null }, []>(
        "SELECT id, external_id, canonical_url FROM item WHERE service = 'zendesk' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.id)).toEqual(["zendesk:1", "zendesk:2"]);
    expect(rows[0]?.canonical_url).toBe(`${h.fake.baseUrl}/agent/tickets/1`);
  });

  test("cursor walk: follows meta.after_cursor while has_more is true", async () => {
    h = startHarness({ pages: [fullPage(1), fullPage(101), [ticket(201)]] });
    await seedCreds(h);

    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(201);
    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/tickets.json");
    expect(reqs).toHaveLength(3);
    expect(reqs[0]?.query.includes("page%5Bafter%5D")).toBe(false);
    expect(reqs[1]?.query).toContain("page%5Bafter%5D=1");
    expect(reqs[2]?.query).toContain("page%5Bafter%5D=2");
  });

  test("MAX_PAGES cap halts the walk", async () => {
    const pages = Array.from({ length: 25 }, (_, i) => fullPage(i * 100 + 1));
    h = startHarness({ pages });
    await seedCreds(h);

    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    const reqs = h.fake.requests.filter((r) => r.path === "/api/v2/tickets.json");
    expect(reqs).toHaveLength(20);
    expect(result.itemsUpserted).toBe(20 * 100);
  });

  test("noop when zendesk.url set but api_token unset — no requests", async () => {
    h = startHarness({ pages: [[ticket(1)]] });
    await h.vault.set("zendesk.url", h.fake.baseUrl);
    await h.vault.set("zendesk.email", "agent@acme.com");
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when email unset — no requests", async () => {
    h = startHarness({ pages: [[ticket(1)]] });
    await h.vault.set("zendesk.url", h.fake.baseUrl);
    await h.vault.set("zendesk.api_token", "tok");
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty ticket list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: [[]] });
    await seedCreds(h);
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zendesk1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    await seedCreds(h);
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zendesk1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    await seedCreds(h);
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-zendesk1:")).toBe(true);
  });

  test("a ticket missing its id is skipped, well-formed siblings still upsert", async () => {
    const noId = ticket(0);
    delete noId["id"];
    h = startHarness({ pages: [[noId, ticket(7)]] });
    await seedCreds(h);
    const syncable = createZendeskSyncable({ ensureZendeskMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    const rows = h.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'zendesk'")
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["7"]);
  });
});
