import { expect, test } from "bun:test";
import { createBigeyeSyncable } from "./bigeye-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  expectSyncNoopResult,
  type SyncTestFetchParams,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";

const FULL_CREDS = {
  "bigeye.base_url": "https://app.bigeye.com",
  "bigeye.api_key": "test-api-key",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function issuesResponse(issues: Record<string, unknown>[]): Response {
  return new Response(JSON.stringify(issues), { status: 200 });
}

function makeSyncable() {
  return createBigeyeSyncable({ ensureBigeyeMcpRunning: async () => {} });
}

describeWithFetchRestore("bigeye-sync", () => {
  // ─── No-op when credentials are missing ────────────────────────────────────

  test("no-op when base_url is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "bigeye.api_key": "key" })),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "bigeye", 0);
  });

  test("no-op when api_key is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "bigeye.base_url": "https://app.bigeye.com" })),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when both credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault({})), null);
    expectSyncNoopResult(r);
  });

  test("no-op when base_url is not a safe URL", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "bigeye.base_url": "not-a-url", "bigeye.api_key": "key" }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── HTTP / parse errors ────────────────────────────────────────────────────

  test("http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bigeye1:");
    expectServiceItemCount(db, "bigeye", 0);
  });

  test("parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-json{", { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bigeye1:");
  });

  test("incoming cursor is preserved on http_error", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Bad Gateway", { status: 502 }));
    const incomingCursor = "nimbus-bigeye1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS)),
      incomingCursor,
    );
    expect(r.cursor).toBe(incomingCursor);
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  test("happy path: indexes one issue with externalId bigeye:7", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      issuesResponse([
        {
          issueId: "7",
          monitoredTable: "ANALYTICS.PUBLIC.ORDERS",
          slaStatus: "breached",
        },
      ]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-bigeye1:");
    expectServiceItemCount(db, "bigeye", 1);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'bigeye'").get() as {
      external_id: string;
    } | null;
    expect(row?.external_id).toBe("bigeye:7");
  });

  test("monitoredDataModelKeys is stored normalized in metadata", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      issuesResponse([
        {
          issueId: "7",
          monitoredTable: "ANALYTICS.PUBLIC.ORDERS",
          slaStatus: "breached",
        },
      ]),
    );
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'bigeye'").get() as {
      metadata: string;
    } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual(["analytics.public.orders"]);
  });

  test("empty issue list → success with zero upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => issuesResponse([]));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bigeye1:");
  });

  test("cursor is nimbus-bigeye1: prefixed on success", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => issuesResponse([]));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.cursor).toMatch(/^nimbus-bigeye1:/);
  });

  test("GET uses Authorization Bearer header", async () => {
    const db = createMemoryIndexDb();
    let capturedHeaders: Record<string, string> = {};
    installFetch((_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
      return issuesResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedHeaders["Authorization"]).toBe("Bearer test-api-key");
  });

  test("GET calls the correct issues endpoint URL", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    installFetch((url) => {
      capturedUrl = url;
      return issuesResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedUrl).toBe("https://app.bigeye.com/api/v1/issues");
  });

  test("issues missing issueId are skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      issuesResponse([
        { slaStatus: "breached" }, // no issueId → skipped
        { issueId: "5", slaStatus: "ok" },
      ]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "bigeye", 1);
  });
});
