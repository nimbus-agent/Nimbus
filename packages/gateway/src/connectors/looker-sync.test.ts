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
import { createLookerSyncable } from "./looker-sync.ts";

const FULL_CREDS = {
  "looker.base_url": "https://looker.example.com",
  "looker.client_id": "my-client-id",
  "looker.client_secret": "my-client-secret",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function loginOk(token = "access-tok-123"): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 200 });
}

function makeSyncable() {
  return createLookerSyncable({ ensureLookerMcpRunning: async () => {} });
}

function dashboard(id: string, title = `Dashboard ${id}`): Record<string, unknown> {
  return { id, title, folder: "Shared" };
}

function lookmlModel(
  name: string,
  views: Array<{ name: string; sql_table_name?: string }>,
): Record<string, unknown> {
  return {
    name,
    explores: [
      {
        views: views.map((v) => ({ name: v.name, sql_table_name: v.sql_table_name })),
      },
    ],
  };
}

describeWithFetchRestore("looker-sync", () => {
  // ─── No-op when credentials are missing ────────────────────────────────────

  test("no-op when base_url is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({ "looker.client_id": "id", "looker.client_secret": "secret" }),
      ),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "looker", 0);
  });

  test("no-op when client_id is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "looker.base_url": "https://looker.example.com",
          "looker.client_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when client_secret is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "looker.base_url": "https://looker.example.com",
          "looker.client_id": "id",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when base_url is whitespace-only (covers isSafeLookerUrl false via empty trim)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "looker.base_url": "   ",
          "looker.client_id": "id",
          "looker.client_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── Login failures ─────────────────────────────────────────────────────────

  test("login http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
    expectServiceItemCount(db, "looker", 0);
  });

  test("login parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/login")
        ? new Response("not-json{", { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  test("login returns no access_token → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/login")
        ? new Response(JSON.stringify({ access_token: "" }), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  // ─── Dashboard list failures ────────────────────────────────────────────────

  test("dashboards http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/login") ? loginOk() : new Response("Server Error", { status: 500 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  test("dashboards parse_error → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/login")
        ? loginOk()
        : url.includes("/dashboards")
          ? new Response("garbage{", { status: 200 })
          : new Response(JSON.stringify([]), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── Models list failures ───────────────────────────────────────────────────

  test("lookml_models http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        return new Response(JSON.stringify([dashboard("1")]), { status: 200 });
      return new Response("Server Error", { status: 500 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  test("happy path: indexes dashboards AND data_model items from views with sql_table_name", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        return new Response(JSON.stringify([dashboard("42", "Sales Overview")]), { status: 200 });
      // /lookml_models
      return new Response(
        JSON.stringify([
          lookmlModel("ecommerce", [{ name: "orders", sql_table_name: "ANALYTICS.PUBLIC.ORDERS" }]),
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(2);
    expect(r.cursor).toContain("nimbus-looker1:");
    expectServiceItemCount(db, "looker", r.itemsUpserted);
    const types = (
      db.prepare("SELECT type FROM item WHERE service = 'looker' ORDER BY type").all() as {
        type: string;
      }[]
    ).map((t) => t.type);
    expect(types).toEqual(["dashboard", "data_model"]);
  });

  test("dashboard item has externalId looker:dashboard/<id>", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        return new Response(JSON.stringify([dashboard("99")]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'looker'").get() as {
      external_id: string;
    } | null;
    expect(row?.external_id).toBe("looker:dashboard/99");
  });

  test("data_model item has correct externalId and normalized metadata", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          lookmlModel("ecommerce", [{ name: "orders", sql_table_name: "ANALYTICS.PUBLIC.ORDERS" }]),
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT external_id, metadata FROM item WHERE service = 'looker'")
      .get() as {
      external_id: string;
      metadata: string;
    } | null;
    expect(row?.external_id).toBe("looker:view/ecommerce.orders");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["dataModelKey"]).toBe("analytics.public.orders");
  });

  test("views without sql_table_name are skipped (mapper returns null)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          lookmlModel("ecommerce", [
            { name: "no_table" }, // no sql_table_name → mapper returns null
          ]),
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("Authorization header uses 'token' scheme", async () => {
    const db = createMemoryIndexDb();
    let capturedAuthHeader = "";
    installFetch((url, init) => {
      if (url.includes("/login")) return loginOk("my-token-abc");
      capturedAuthHeader =
        (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedAuthHeader).toBe("token my-token-abc");
  });

  test("login POST uses form-encoded credentials", async () => {
    const db = createMemoryIndexDb();
    let capturedBody = "";
    installFetch((url, init) => {
      if (url.includes("/login")) {
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return loginOk();
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedBody).toContain("client_id=my-client-id");
    expect(capturedBody).toContain("client_secret=my-client-secret");
  });

  test("empty dashboard array returns success with zero dashboard upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  test("cursor is nimbus-looker1: prefixed on success", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.cursor).toMatch(/^nimbus-looker1:/);
  });

  test("incoming cursor is preserved on login http_error", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Bad Gateway", { status: 502 }));
    const incomingCursor = "nimbus-looker1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS)),
      incomingCursor,
    );
    expect(r.cursor).toBe(incomingCursor);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── lookml_models parse_error ─────────────────────────────────────────────

  test("lookml_models parse_error → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("garbage{", { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-looker1:");
  });

  // ─── dashboardsFromResponse edge branches ──────────────────────────────────

  test("dashboards response that is not an array → zero dashboard upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("dashboard array entry that is not a record is skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        return new Response(JSON.stringify([null, "string", dashboard("10", "Valid")]), {
          status: 200,
        });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    // null and "string" are skipped; "Valid" dashboard is indexed
    expect(r.itemsUpserted).toBe(1);
  });

  test("dashboard mapper returns null (missing id) → skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards"))
        // No id field → mapper returns null
        return new Response(JSON.stringify([{ title: "No ID" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── viewsFromModelsResponse edge branches ─────────────────────────────────

  test("models response that is not an array → zero view upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("model array entry that is not a record is skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          null, // not a record → skipped
          lookmlModel("ecommerce", [{ name: "orders", sql_table_name: "DB.SCH.ORDERS" }]),
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
  });

  test("model with empty name is skipped (modelName empty branch)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          { name: "", explores: [{ views: [{ name: "v", sql_table_name: "DB.S.T" }] }] },
          lookmlModel("good", [{ name: "v2", sql_table_name: "DB.S.T2" }]),
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    // Only the "good" model's view is indexed
    expect(r.itemsUpserted).toBe(1);
  });

  test("model with no 'explores' array → zero views (non-array explores branch)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([{ name: "ecommerce", explores: "not-an-array" }]), {
        status: 200,
      });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("explore entry that is not a record is skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          {
            name: "ecommerce",
            explores: [
              null, // not a record → skipped
              { views: [{ name: "orders", sql_table_name: "DB.S.ORDERS" }] },
            ],
          },
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
  });

  test("explore with non-array 'views' → zero views (non-array views branch)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([{ name: "ecommerce", explores: [{ views: "not-array" }] }]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
  });

  test("view entry that is not a record inside explore is skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/login")) return loginOk();
      if (url.includes("/dashboards")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(
        JSON.stringify([
          {
            name: "ecommerce",
            explores: [
              {
                views: [
                  null, // not a record → skipped
                  { name: "orders", sql_table_name: "DB.S.ORDERS" },
                ],
              },
            ],
          },
        ]),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
  });
});
