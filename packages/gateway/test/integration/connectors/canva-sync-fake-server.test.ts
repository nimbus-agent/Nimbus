import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createCanvaSyncable } from "../../../src/connectors/canva-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { installHostInterceptFetch } from "../../helpers/host-intercept-fetch.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const BASE = "https://api.canva.com";

interface RecordedReq {
  method: string;
  pathname: string;
  continuation: string | null;
  auth: string | null;
}

interface FakeConfig {
  // Map of `continuation` query value ("" for the first page) → response page.
  pages?: Record<string, { items: unknown[]; nextContinuation?: string }>;
  status?: number;
}

interface FakeServer {
  requests: RecordedReq[];
  fetch: typeof globalThis.fetch;
  restore: () => void;
}

function installFakeFetch(config: FakeConfig): FakeServer {
  return installHostInterceptFetch<RecordedReq>({
    base: BASE,
    record: (u, init) => ({
      method: init?.method ?? "GET",
      pathname: u.pathname,
      continuation: u.searchParams.get("continuation"),
      auth: new Headers(init?.headers).get("authorization"),
    }),
    respond: (req) => {
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const page = config.pages?.[req.continuation ?? ""] ?? { items: [] };
      const body: Record<string, unknown> = { items: page.items };
      if (page.nextContinuation !== undefined && page.nextContinuation !== "") {
        body["continuation"] = page.nextContinuation;
      }
      return Response.json(body);
    },
  });
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeServer;
  cleanup: () => void;
}

function startHarness(config: FakeConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = installFakeFetch(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.restore();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "canva"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        canva: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function design(id: string, title: string): unknown {
  return {
    id,
    title,
    created_at: 1_735_776_000,
    updated_at: 1_747_699_200,
    urls: {
      edit_url: `https://www.canva.com/design/${id}/edit`,
      view_url: `https://www.canva.com/design/${id}/view`,
    },
    thumbnail: { url: `https://thumb.canva.com/${id}.png`, width: 200, height: 120 },
  };
}

/** Set a non-expired canva.oauth payload so the registry returns the cached token without refreshing. */
async function setOAuth(h: Harness): Promise<void> {
  await h.vault.set(
    "canva.oauth",
    JSON.stringify({
      accessToken: "canva-access",
      refreshToken: "canva-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["design:meta:read"],
    }),
  );
}

describe("canva-sync against a fake api.canva.com", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: walks the continuation across pages, Bearer header, pass-1 cursor", async () => {
    h = startHarness({
      pages: {
        "": { items: [design("1", "Alpha"), design("2", "Beta")], nextContinuation: "p2" },
        p2: { items: [design("3", "Gamma")] },
      },
    });
    await setOAuth(h);

    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-canva1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.pathname === "/rest/v1/designs");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.auth).toBe("Bearer canva-access");
    expect(reqs[0]?.continuation).toBeNull();
    expect(reqs[1]?.continuation).toBe("p2");

    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'canva' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2", "3"]);
  });

  test("noop when canva.oauth unset — no requests", async () => {
    h = startHarness({ pages: { "": { items: [design("1", "Alpha")] } } });
    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 (rate-limited) degrades gracefully — no throw, zero upserts, pass-1 cursor", async () => {
    h = startHarness({ status: 429 });
    await setOAuth(h);
    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-canva1:")).toBe(true);
  });

  test("a 401 (auth failure) degrades gracefully — no throw, zero upserts, cursor preserved", async () => {
    h = startHarness({ status: 401 });
    await setOAuth(h);
    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, "nimbus-canva1:prev");
    expect(result.itemsUpserted).toBe(0);
    // First-page http error preserves the incoming cursor.
    expect(result.cursor).toBe("nimbus-canva1:prev");
  });

  test("mid-walk error keeps page-1 upserts without throwing", async () => {
    let call = 0;
    const realFetchLocal = globalThis.fetch;
    h = startHarness({});
    // Override with a stateful fake: first call ok, second call errors.
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = requestUrl(input);
      if (new URL(urlStr).origin !== BASE) {
        return realFetchLocal(input, init);
      }
      h?.fake.requests.push({
        method: init?.method ?? "GET",
        pathname: new URL(urlStr).pathname,
        continuation: new URL(urlStr).searchParams.get("continuation"),
        auth: new Headers(init?.headers).get("authorization"),
      });
      call += 1;
      if (call === 1) {
        return Response.json({ items: [design("1", "Alpha")], continuation: "p2" });
      }
      return new Response("boom", { status: 500 });
    };
    await setOAuth(h);

    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-canva1:")).toBe(true);
  });

  test("empty first page yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ pages: { "": { items: [] } } });
    await setOAuth(h);
    const syncable = createCanvaSyncable({ ensureCanvaMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-canva1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.pathname === "/rest/v1/designs")).toHaveLength(1);
  });
});
