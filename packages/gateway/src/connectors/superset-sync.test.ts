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
import { createSupersetSyncable } from "./superset-sync.ts";

const FULL_CREDS = {
  "superset.url": "https://superset.example.com",
  "superset.username": "admin",
  "superset.password": "secret",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function loginOk(token = "tok-123"): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 200 });
}

function makeSyncable() {
  return createSupersetSyncable({ ensureSupersetMcpRunning: async () => {} });
}

function dashboard(id: number, title = `D${String(id)}`): Record<string, unknown> {
  return {
    id,
    dashboard_title: title,
    slug: `slug-${String(id)}`,
    status: "published",
    published: true,
    changed_on_utc: "2026-04-01T12:00:00.000Z",
    changed_by: { first_name: "Ada", last_name: "Lovelace" },
    owners: [{}, {}],
  };
}

describeWithFetchRestore("superset-sync", () => {
  test("no-op when url secret missing (covers ?? '' fallback)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "superset.username": "admin", "superset.password": "secret" }),
        "superset",
      ),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "superset", 0);
  });

  test("no-op when username secret missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "superset.url": "https://s.example.com",
          "superset.password": "secret",
        }),
        "superset",
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when password secret missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "superset.url": "https://s.example.com",
          "superset.username": "admin",
        }),
        "superset",
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when a secret is present but blank (covers trim → '')", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "superset.url": "  ",
          "superset.username": "admin",
          "superset.password": "secret",
        }),
        "superset",
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("trailing slash in url is trimmed (covers trimTrailingSlash true side)", async () => {
    const db = createMemoryIndexDb();
    let loginUrl = "";
    installFetch((url) => {
      if (url.includes("/security/login")) {
        loginUrl = url;
        return loginOk();
      }
      return new Response(JSON.stringify({ result: [dashboard(1)] }), { status: 200 });
    });
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ ...FULL_CREDS, "superset.url": "https://s.example.com/" }),
        "superset",
      ),
      null,
    );
    expect(loginUrl).toBe("https://s.example.com/api/v1/security/login");
    expect(r.itemsUpserted).toBe(1);
  });

  test("url without trailing slash is left intact (covers trimTrailingSlash false side)", async () => {
    const db = createMemoryIndexDb();
    let loginUrl = "";
    installFetch((url) => {
      if (url.includes("/security/login")) {
        loginUrl = url;
        return loginOk();
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS), "superset"), null);
    expect(loginUrl).toBe("https://superset.example.com/api/v1/security/login");
  });

  test("login http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("nope", { status: 401 }));
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-superset1:");
    expectServiceItemCount(db, "superset", 0);
  });

  test("login parse_error (invalid JSON) → http-empty pass cursor (covers line 66)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? new Response("not-json{", { status: 200 })
        : new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-superset1:");
  });

  test("login returns no access_token → http-empty", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? new Response(JSON.stringify({ access_token: "" }), { status: 200 })
        : new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("dashboard list http_error on page 0 → http-empty", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login") ? loginOk() : new Response("boom", { status: 500 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-superset1:");
  });

  test("dashboard list parse_error on page 0 → parse-empty (covers line 143)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login") ? loginOk() : new Response("garbage{", { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("happy path: indexes dashboards from result array (covers extractResult array side)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? loginOk()
        : new Response(JSON.stringify({ result: [dashboard(1), dashboard(2)] }), { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "superset", 2);
  });

  test("bare-array response shape is accepted (covers extractResult fallback side)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? loginOk()
        : new Response(JSON.stringify([dashboard(7)]), { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("unmappable entries are skipped (covers upsertDashboards mapped===null)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? loginOk()
        : new Response(JSON.stringify({ result: [dashboard(1), { no_id: true }, "junk"] }), {
            status: 200,
          }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("empty result returns success with zero upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/security/login")
        ? loginOk()
        : new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-superset1:");
  });

  test("paginates across full pages then stops on a short page", async () => {
    const db = createMemoryIndexDb();
    let page = 0;
    installFetch((url) => {
      if (url.includes("/security/login")) return loginOk();
      page += 1;
      if (page === 1) {
        const full = Array.from({ length: 100 }, (_v, i) => dashboard(i + 1));
        return new Response(JSON.stringify({ result: full }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: [dashboard(101)] }), { status: 200 });
    });
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(101);
    expect(page).toBe(2);
  });

  test("http_error on a later page breaks loop but keeps prior upserts (covers page>0 break)", async () => {
    const db = createMemoryIndexDb();
    let page = 0;
    installFetch((url) => {
      if (url.includes("/security/login")) return loginOk();
      page += 1;
      if (page === 1) {
        const full = Array.from({ length: 100 }, (_v, i) => dashboard(i + 1));
        return new Response(JSON.stringify({ result: full }), { status: 200 });
      }
      return new Response("err", { status: 500 });
    });
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS), "superset"),
      null,
    );
    expect(r.itemsUpserted).toBe(100);
    expect(page).toBe(2);
  });
});
