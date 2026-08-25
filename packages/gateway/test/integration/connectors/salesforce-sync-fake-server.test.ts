import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";
import { createSalesforceSyncable } from "../../../src/connectors/salesforce-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { installHostInterceptFetch } from "../../helpers/host-intercept-fetch.ts";
import { requestUrl } from "../../helpers/request-url.ts";

const INSTANCE_URL = "https://acme.my.salesforce.com";

interface RecordedReq {
  method: string;
  pathname: string;
  search: string;
  auth: string | null;
}

interface FakePage {
  records: unknown[];
  done: boolean;
  nextRecordsUrl?: string;
}

interface FakeConfig {
  // The first SOQL query response (pathname /services/data/v60.0/query).
  first?: FakePage;
  // Follow-up pages keyed by their nextRecordsUrl pathname.
  byPath?: Record<string, FakePage>;
  status?: number;
}

interface FakeServer {
  requests: RecordedReq[];
  fetch: typeof globalThis.fetch;
  restore: () => void;
}

function pageBody(page: FakePage): Record<string, unknown> {
  const body: Record<string, unknown> = {
    totalSize: page.records.length,
    done: page.done,
    records: page.records,
  };
  if (page.nextRecordsUrl !== undefined && page.nextRecordsUrl !== "") {
    body["nextRecordsUrl"] = page.nextRecordsUrl;
  }
  return body;
}

function installFakeFetch(config: FakeConfig): FakeServer {
  return installHostInterceptFetch<RecordedReq>({
    base: INSTANCE_URL,
    record: (u, init) => ({
      method: init?.method ?? "GET",
      pathname: u.pathname,
      search: u.search,
      auth: new Headers(init?.headers).get("authorization"),
    }),
    respond: (req) => {
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const isFirst = req.pathname === "/services/data/v60.0/query";
      const page = isFirst
        ? (config.first ?? { records: [], done: true })
        : (config.byPath?.[req.pathname] ?? { records: [], done: true });
      return Response.json(pageBody(page));
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "salesforce"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        salesforce: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function opp(id: string, name: string): unknown {
  return {
    Id: id,
    Name: name,
    StageName: "Proposal/Price Quote",
    Amount: 1000,
    CloseDate: "2026-06-30",
    Probability: 50,
    Type: "New Business",
    IsClosed: false,
    IsWon: false,
    LastModifiedDate: "2026-05-20T12:00:00.000+0000",
    CreatedDate: "2026-01-02T00:00:00.000+0000",
  };
}

/**
 * Set a non-expired salesforce.oauth payload (with instance_url) so the registry
 * returns the cached token without refreshing and getValidSalesforceAuth reads
 * the instance host back from the blob.
 */
async function setOAuth(h: Harness): Promise<void> {
  await h.vault.set(
    "salesforce.oauth",
    JSON.stringify({
      accessToken: "sf-access",
      refreshToken: "sf-refresh",
      expiresAt: Date.now() + 3_600_000,
      scopes: ["api", "refresh_token"],
      instanceUrl: INSTANCE_URL,
    }),
  );
}

describe("salesforce-sync against a fake instance host", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: walks nextRecordsUrl across pages, Bearer header, pass-1 cursor", async () => {
    h = startHarness({
      first: {
        records: [opp("0061", "Alpha"), opp("0062", "Beta")],
        done: false,
        nextRecordsUrl: "/services/data/v60.0/query/01g-2000",
      },
      byPath: {
        "/services/data/v60.0/query/01g-2000": {
          records: [opp("0063", "Gamma")],
          done: true,
        },
      },
    });
    await setOAuth(h);

    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-salesforce1:")).toBe(true);

    // Two fetches: the initial SOQL query, then the nextRecordsUrl follow-up.
    expect(h.fake.requests).toHaveLength(2);
    expect(h.fake.requests[0]?.pathname).toBe("/services/data/v60.0/query");
    expect(h.fake.requests[0]?.auth).toBe("Bearer sf-access");
    expect(h.fake.requests[0]?.search).toContain("q=");
    expect(h.fake.requests[1]?.pathname).toBe("/services/data/v60.0/query/01g-2000");

    const rows = h.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'salesforce' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["0061", "0062", "0063"]);
  });

  test("single-page (done: true) stops after one request", async () => {
    h = startHarness({ first: { records: [opp("0061", "Alpha")], done: true } });
    await setOAuth(h);
    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests).toHaveLength(1);
  });

  test("noop when salesforce.oauth unset — no requests", async () => {
    h = startHarness({ first: { records: [opp("0061", "Alpha")], done: true } });
    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("noop when instance_url missing from the stored blob (no silent fallback)", async () => {
    h = startHarness({ first: { records: [opp("0061", "Alpha")], done: true } });
    await h.vault.set(
      "salesforce.oauth",
      JSON.stringify({
        accessToken: "sf-access",
        refreshToken: "sf-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["api"],
        // instanceUrl intentionally absent → getValidSalesforceAuth throws → noop.
      }),
    );
    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 401 (auth failure) degrades gracefully — no throw, cursor preserved", async () => {
    h = startHarness({ status: 401 });
    await setOAuth(h);
    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, "nimbus-salesforce1:prev");
    expect(result.itemsUpserted).toBe(0);
    // First-page http error preserves the incoming cursor.
    expect(result.cursor).toBe("nimbus-salesforce1:prev");
  });

  test("mid-walk error keeps page-1 upserts without throwing", async () => {
    let call = 0;
    const realFetchLocal = globalThis.fetch;
    h = startHarness({});
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = requestUrl(input);
      if (new URL(urlStr).origin !== INSTANCE_URL) {
        return realFetchLocal(input, init);
      }
      h?.fake.requests.push({
        method: init?.method ?? "GET",
        pathname: new URL(urlStr).pathname,
        search: new URL(urlStr).search,
        auth: new Headers(init?.headers).get("authorization"),
      });
      call += 1;
      if (call === 1) {
        return Response.json({
          totalSize: 1,
          done: false,
          records: [opp("0061", "Alpha")],
          nextRecordsUrl: "/services/data/v60.0/query/01g-2000",
        });
      }
      return new Response("boom", { status: 500 });
    };
    await setOAuth(h);

    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-salesforce1:")).toBe(true);
  });

  test("empty first page yields zero upserts and a pass-1 cursor", async () => {
    h = startHarness({ first: { records: [], done: true } });
    await setOAuth(h);
    const syncable = createSalesforceSyncable({ ensureSalesforceMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-salesforce1:")).toBe(true);
    expect(h.fake.requests).toHaveLength(1);
  });
});
