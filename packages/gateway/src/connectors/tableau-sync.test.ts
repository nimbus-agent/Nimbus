import { expect, test } from "bun:test";

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
import { createTableauSyncable } from "./tableau-sync.ts";

const FULL_CREDS = {
  "tableau.url": "https://tableau.example.com",
  "tableau.pat_name": "my-pat-name",
  "tableau.pat_secret": "my-pat-secret",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function makeSyncable() {
  return createTableauSyncable({ ensureTableauMcpRunning: async () => {} });
}

function signinOk(token = "auth-tok", siteId = "site-123"): Response {
  return new Response(
    JSON.stringify({
      credentials: { token, site: { id: siteId } },
    }),
    { status: 200 },
  );
}

function viewsOk(views: Record<string, unknown>[] = []): Response {
  return new Response(JSON.stringify({ views: { view: views } }), { status: 200 });
}

function sampleView(luid = "v1", name = "Revenue Overview"): Record<string, unknown> {
  return { luid, name, owner: { name: "Alice" } };
}

describeWithFetchRestore("tableau-sync", () => {
  // ─── No-op when credentials are missing ────────────────────────────────────

  test("no-op when url is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "tableau.pat_name": "name", "tableau.pat_secret": "secret" }),
      ),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "tableau", 0);
  });

  test("no-op when pat_name is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "tableau.url": "https://tableau.example.com",
          "tableau.pat_secret": "s",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when pat_secret is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "tableau.url": "https://tableau.example.com", "tableau.pat_name": "n" }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when url is not a valid URL (isSafeTableauUrl false branch)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "tableau.url": "not-a-url",
          "tableau.pat_name": "name",
          "tableau.pat_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when url is empty string (isSafeTableauUrl empty path)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "tableau.url": "",
          "tableau.pat_name": "name",
          "tableau.pat_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── Signin step failures ───────────────────────────────────────────────────

  test("signin http_error → http-empty pass cursor, preserves incoming cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const incomingCursor = "nimbus-tableau1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS)),
      incomingCursor,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(incomingCursor);
    expectServiceItemCount(db, "tableau", 0);
  });

  test("signin parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-json{", { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  test("signin returns no credentials field → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response(JSON.stringify({ other: "data" }), { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  test("signin returns credentials without token → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      () =>
        new Response(JSON.stringify({ credentials: { site: { id: "site-1" } } }), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  test("signin returns credentials without siteId → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      () => new Response(JSON.stringify({ credentials: { token: "tok" } }), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  // ─── Views step failures ────────────────────────────────────────────────────

  test("views http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin") ? signinOk() : new Response("Server Error", { status: 500 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
    expectServiceItemCount(db, "tableau", 0);
  });

  test("views parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin") ? signinOk() : new Response("garbage{", { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  test("happy path: indexes a view with luid and name", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin") ? signinOk() : viewsOk([sampleView("v42", "Sales Overview")]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toMatch(/^nimbus-tableau1:/);
    expectServiceItemCount(db, "tableau", 1);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'tableau'").get() as {
      external_id: string;
    } | null;
    expect(row?.external_id).toBe("tableau:v42");
  });

  test("X-Tableau-Auth header is sent to views endpoint", async () => {
    const db = createMemoryIndexDb();
    let capturedAuth = "";
    installFetch((url, init) => {
      if (url.includes("/auth/signin")) return signinOk("my-token");
      capturedAuth =
        (init?.headers as Record<string, string> | undefined)?.["X-Tableau-Auth"] ?? "";
      return viewsOk([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedAuth).toBe("my-token");
  });

  test("empty views array → success with zero upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => (url.includes("/auth/signin") ? signinOk() : viewsOk([])));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-tableau1:");
  });

  test("view missing luid is skipped (mapper returns null)", async () => {
    const db = createMemoryIndexDb();
    installFetch(
      (url) => (url.includes("/auth/signin") ? signinOk() : viewsOk([{ name: "NoLuid" }])), // no luid → mapper returns null
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("view uses workbook name as fallback when view name is empty", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin")
        ? signinOk()
        : viewsOk([
            {
              luid: "v5",
              name: "",
              workbook: { name: "Workbook Alpha" },
              owner: { name: null },
            },
          ]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    // displayName = workbookName = "Workbook Alpha" → mapper should produce a title
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT title FROM item WHERE service = 'tableau'").get() as {
      title: string;
    } | null;
    expect(row?.title).toBe("Workbook Alpha");
  });

  test("view with non-record entry in viewArr is skipped (asRecord undefined branch)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin")
        ? signinOk()
        : new Response(
            JSON.stringify({ views: { view: [null, "string", 42, sampleView("v1")] } }),
            { status: 200 },
          ),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    // null, "string", 42 are skipped; v1 is mapped
    expect(r.itemsUpserted).toBe(1);
  });

  test("views response with non-array 'view' field → no items (empty viewArr fallback)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin")
        ? signinOk()
        : new Response(JSON.stringify({ views: { view: "not-an-array" } }), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("views response missing 'views' key → no items", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin") ? signinOk() : new Response(JSON.stringify({}), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("view with no owner field → author is null in metadata", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/auth/signin") ? signinOk() : viewsOk([{ luid: "v9", name: "No Owner" }]),
    );
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'tableau'").get() as {
      metadata: string;
    } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["author"]).toBeNull();
  });

  test("signin uses POST with JSON body and Content-Type", async () => {
    const db = createMemoryIndexDb();
    let capturedBody = "";
    let capturedContentType = "";
    installFetch((url, init) => {
      if (url.includes("/auth/signin")) {
        capturedBody = typeof init?.body === "string" ? init.body : "";
        capturedContentType =
          (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ?? "";
        return signinOk();
      }
      return viewsOk([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedContentType).toBe("application/json");
    const body = JSON.parse(capturedBody) as { credentials: { personalAccessTokenName: string } };
    expect(body.credentials.personalAccessTokenName).toBe("my-pat-name");
  });

  test("cursor is nimbus-tableau1: prefixed on success", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => (url.includes("/auth/signin") ? signinOk() : viewsOk([])));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.cursor).toMatch(/^nimbus-tableau1:/);
  });
});
