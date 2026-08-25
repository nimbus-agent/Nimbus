import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createMiroSyncable } from "../../../src/connectors/miro-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { installHostInterceptFetch } from "../../helpers/host-intercept-fetch.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const BASE = "https://api.miro.com";

interface RecordedReq {
  method: string;
  pathname: string;
  cursor: string | null;
  auth: string | null;
}

interface FakeConfig {
  // Map of `cursor` query value ("" for the first page) → response page.
  pages?: Record<string, { data: unknown[]; nextCursor?: string }>;
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
      cursor: u.searchParams.get("cursor"),
      auth: new Headers(init?.headers).get("authorization"),
    }),
    respond: (req) => {
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const page = config.pages?.[req.cursor ?? ""] ?? { data: [] };
      const body: Record<string, unknown> = { data: page.data };
      if (page.nextCursor !== undefined && page.nextCursor !== "") {
        body["cursor"] = page.nextCursor;
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "miro"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        miro: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function board(id: string, name: string): unknown {
  return {
    id,
    name,
    description: "A board",
    createdAt: "2026-01-02T00:00:00Z",
    modifiedAt: "2026-05-20T00:00:00Z",
    owner: { name: "Owner" },
    viewLink: `https://miro.com/app/board/${id}=/`,
  };
}

/** Set a non-expired miro.oauth payload so the registry returns the cached token without refreshing. */
async function setOAuth(h: Harness): Promise<void> {
  await h.vault.set(
    "miro.oauth",
    JSON.stringify({
      accessToken: "miro-access",
      refreshToken: "miro-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["boards:read"],
    }),
  );
}

describe("miro-sync against a fake api.miro.com", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: walks the cursor across pages, Bearer header, pass-1 cursor", async () => {
    h = startHarness({
      pages: {
        "": { data: [board("1", "Alpha"), board("2", "Beta")], nextCursor: "p2" },
        p2: { data: [board("3", "Gamma")] },
      },
    });
    await setOAuth(h);

    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-miro1:")).toBe(true);

    const reqs = h.fake.requests.filter((r) => r.pathname === "/v2/boards");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.auth).toBe("Bearer miro-access");
    expect(reqs[0]?.cursor).toBeNull();
    expect(reqs[1]?.cursor).toBe("p2");

    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'miro' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["1", "2", "3"]);
  });

  test("noop when miro.oauth unset — no requests", async () => {
    h = startHarness({ pages: { "": { data: [board("1", "Alpha")] } } });
    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 (rate-limited) degrades gracefully — no throw, zero upserts, pass-1 cursor", async () => {
    h = startHarness({ status: 429 });
    await setOAuth(h);
    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-miro1:")).toBe(true);
  });

  test("a 401 (auth failure) degrades gracefully — no throw, zero upserts, cursor preserved", async () => {
    h = startHarness({ status: 401 });
    await setOAuth(h);
    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, "nimbus-miro1:prev");
    expect(result.itemsUpserted).toBe(0);
    // First-page http error preserves the incoming cursor.
    expect(result.cursor).toBe("nimbus-miro1:prev");
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
        cursor: new URL(urlStr).searchParams.get("cursor"),
        auth: new Headers(init?.headers).get("authorization"),
      });
      call += 1;
      if (call === 1) {
        return Response.json({ data: [board("1", "Alpha")], cursor: "p2" });
      }
      return new Response("boom", { status: 500 });
    };
    await setOAuth(h);

    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-miro1:")).toBe(true);
  });

  test("empty first page yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ pages: { "": { data: [] } } });
    await setOAuth(h);
    const syncable = createMiroSyncable({ ensureMiroMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-miro1:")).toBe(true);
    expect(h.fake.requests.filter((r) => r.pathname === "/v2/boards")).toHaveLength(1);
  });
});
