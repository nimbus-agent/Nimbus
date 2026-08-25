import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createIntercomSyncable } from "../../../src/connectors/intercom-sync.ts";
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
  intercomVersion: string | null;
}

interface IntercomPage {
  conversations: unknown[];
  nextStartingAfter?: string | null;
}

interface FakeIntercomConfig {
  pages?: Record<string, IntercomPage>;
  status?: number;
  badJson?: boolean;
}

interface FakeIntercom {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function buildPagesEnvelope(page: IntercomPage): unknown {
  const next =
    typeof page.nextStartingAfter === "string" && page.nextStartingAfter !== ""
      ? { page: 2, starting_after: page.nextStartingAfter }
      : null;
  return {
    type: "conversation.list",
    conversations: page.conversations,
    pages: { type: "pages", next, per_page: 150, total_pages: 1 },
    total_count: page.conversations.length,
  };
}

function startFakeIntercom(config: FakeIntercomConfig): FakeIntercom {
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
        intercomVersion: req.headers.get("intercom-version"),
      });
      if (u.pathname === "/conversations") {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const after = u.searchParams.get("starting_after") ?? "";
        const page = config.pages?.[after] ?? { conversations: [] };
        return Response.json(buildPagesEnvelope(page));
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
  fake: FakeIntercom;
  cleanup: () => void;
}

function startHarness(config: FakeIntercomConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeIntercom(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "intercom"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        intercom: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function conversation(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "conversation",
    state: "open",
    priority: "priority",
    open: true,
    read: false,
    source: {
      type: "conversation",
      subject: `Subject ${id}`,
      body: `<p>conversation ${id} body</p>`,
      author: { type: "user", name: "Ada", email: "ada@example.com" },
    },
    admin_assignee_id: 9001,
    team_assignee_id: 7,
    tags: { type: "tag.list", tags: [{ type: "tag", id: "t1", name: "billing" }] },
    contacts: { type: "contact.list", contacts: [{ type: "contact", id: `c_${id}` }] },
    created_at: 1_700_000_000,
    updated_at: 1_700_500_000,
    ...over,
  };
}

function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.intercom.io", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function fullPage(base: number): unknown[] {
  return Array.from({ length: 150 }, (_, i) => conversation(String(base + i)));
}

describe("intercom-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  test("happy path: single page → upserts with intercom:<id> ids + Bearer + version headers", async () => {
    h = startHarness({
      pages: { "": { conversations: [conversation("11"), conversation("22")] } },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "tok_live_xyz");

    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-intercom1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer tok_live_xyz");
      expect(r.intercomVersion).toBe("2.11");
    }

    const rows = h.db
      .query<{ id: string; external_id: string }, []>(
        "SELECT id, external_id FROM item WHERE service = 'intercom' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["11", "22"]);
    expect(rows.map((r) => r.id)).toEqual(["intercom:11", "intercom:22"]);
  });

  test("multi-page: pages.next.starting_after drives a cursor walk", async () => {
    const firstPage = fullPage(1000);
    h = startHarness({
      pages: {
        "": { conversations: firstPage, nextStartingAfter: "CURSOR_B" },
        CURSOR_B: { conversations: [conversation("2000")] },
      },
    });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "k");

    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(151);
    const reqs = h.fake.requests.filter((r) => r.path === "/conversations");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.query).not.toContain("starting_after");
    expect(reqs[1]?.query).toContain("starting_after=CURSOR_B");
  });

  test("MAX_PAGES cap: a perpetual next cursor stops after 20 pages", async () => {
    h = startHarness({});
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "k");

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
          intercomVersion: req.headers.get("intercom-version"),
        });
        const conversations = Array.from({ length: 150 }, () => {
          serial += 1;
          return conversation(String(serial));
        });
        return Response.json(
          buildPagesEnvelope({ conversations, nextStartingAfter: `cur_${String(serial)}` }),
        );
      },
    });
    const fakeBase = `http://${server.hostname}:${server.port}`;
    restoreFetch?.();
    restoreFetch = withRewrittenFetch(fakeBase);

    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(requests.filter((r) => r.path === "/conversations")).toHaveLength(20);
    expect(result.itemsUpserted).toBe(3000);
    server.stop(true);
  });

  test("noop when token unset — no requests", async () => {
    h = startHarness({ pages: { "": { conversations: [conversation("11")] } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("empty list → zero upserts, pass-1 cursor", async () => {
    h = startHarness({ pages: { "": { conversations: [] } } });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "k");
    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-intercom1:")).toBe(true);
  });

  test("first-page 5xx degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ status: 503 });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "k");
    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-intercom1:")).toBe(true);
  });

  test("first-page parse error degrades gracefully (zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ badJson: true });
    restoreFetch = withRewrittenFetch(h.fake.baseUrl);
    await h.vault.set("intercom.token", "k");
    const syncable = createIntercomSyncable({ ensureIntercomMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-intercom1:")).toBe(true);
  });
});
