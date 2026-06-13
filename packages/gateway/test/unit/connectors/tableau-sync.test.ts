import { expect, test } from "bun:test";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
  urlFromFetchInput,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createTableauSyncable } from "../../../src/connectors/tableau-sync.ts";

function signinResponse(token: string, siteId: string): Response {
  return new Response(
    JSON.stringify({
      credentials: {
        token,
        site: { id: siteId, contentUrl: "" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function viewsResponse(views: Array<{ luid: string; name: string }>): Response {
  return new Response(
    JSON.stringify({
      views: {
        view: views.map((v) => ({
          luid: v.luid,
          name: v.name,
          workbook: { name: `${v.name} Workbook` },
          owner: { name: "test-author" },
        })),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeWithFetchRestore("tableau-sync", () => {
  test("indexes Tableau views as dashboard items", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "tableau.url": "https://tableau.example.com",
      "tableau.pat_name": "my-pat",
      "tableau.pat_secret": "my-secret",
    });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/auth/signin")) {
        return signinResponse("tok-abc", "site-xyz");
      }
      return viewsResponse([{ luid: "v1", name: "Q1 Revenue" }]);
    }) as typeof fetch;
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expect(res.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "tableau", 1);
    const row = db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'tableau'")
      .get();
    expect(row?.external_id).toBe("tableau:v1");
  });

  test("passes X-Tableau-Auth token from signin to views call", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "tableau.url": "https://tableau.example.com",
      "tableau.pat_name": "my-pat",
      "tableau.pat_secret": "my-secret",
    });
    let capturedViewsHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlFromFetchInput(input);
      if (url.includes("/auth/signin")) {
        return signinResponse("auth-token-123", "site-abc");
      }
      capturedViewsHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return viewsResponse([]);
    }) as typeof fetch;
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    await syncable.sync(syncTestContext(db, vault), null);
    expect(capturedViewsHeaders["X-Tableau-Auth"]).toBe("auth-token-123");
  });

  test("no creds → noop", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({});
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expectSyncNoopResult(res);
  });

  test("partial creds (url only) → noop", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({ "tableau.url": "https://tableau.example.com" });
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expectSyncNoopResult(res);
  });

  test("unsafe url (unparseable) → noop", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "tableau.url": "not a url",
      "tableau.pat_name": "pat",
      "tableau.pat_secret": "secret",
    });
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expectSyncNoopResult(res);
  });

  test("signin HTTP error → empty pass cursor (not noop)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "tableau.url": "https://tableau.example.com",
      "tableau.pat_name": "pat",
      "tableau.pat_secret": "secret",
    });
    globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const syncable = createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expect(res.itemsUpserted).toBe(0);
    // cursor advances (not null) on HTTP error
    expect(res.cursor).not.toBeNull();
  });
});
