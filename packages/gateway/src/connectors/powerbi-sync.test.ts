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
import { createPowerBiSyncable } from "./powerbi-sync.ts";

const FULL_CREDS = {
  "powerbi.tenant_id": "my-tenant-id",
  "powerbi.client_id": "my-client-id",
  "powerbi.client_secret": "my-client-secret",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function tokenOk(token = "access-tok-123"): Response {
  return new Response(JSON.stringify({ access_token: token }), { status: 200 });
}

function reportsResponse(reports: Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ value: reports }), { status: 200 });
}

function tablesResponse(tableNames: string[]): Response {
  return new Response(JSON.stringify({ value: tableNames.map((name) => ({ name })) }), {
    status: 200,
  });
}

function makeSyncable() {
  return createPowerBiSyncable({ ensurePowerBiMcpRunning: async () => {} });
}

function report(
  id: string,
  name = `Report ${id}`,
  datasetId = `ds-${id}`,
): Record<string, unknown> {
  return { id, name, datasetId };
}

describeWithFetchRestore("powerbi-sync", () => {
  // ─── No-op when credentials are missing ────────────────────────────────────

  test("no-op when tenant_id is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "powerbi.client_id": "id",
          "powerbi.client_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "powerbi", 0);
  });

  test("no-op when client_id is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "powerbi.tenant_id": "tenant",
          "powerbi.client_secret": "secret",
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
          "powerbi.tenant_id": "tenant",
          "powerbi.client_id": "id",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when tenant_id is whitespace-only (isSafePowerBiTenantId → empty trim)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "powerbi.tenant_id": "   ",
          "powerbi.client_id": "id",
          "powerbi.client_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when tenant_id starts with '-' (flag-smuggling guard)", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "powerbi.tenant_id": "-bad-tenant",
          "powerbi.client_id": "id",
          "powerbi.client_secret": "secret",
        }),
      ),
      null,
    );
    expectSyncNoopResult(r);
  });

  // ─── Token endpoint failures ────────────────────────────────────────────────

  test("token http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
    expectServiceItemCount(db, "powerbi", 0);
  });

  test("token parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-json{", { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
  });

  test("token returns no access_token → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response(JSON.stringify({ access_token: "" }), { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
  });

  // ─── Reports endpoint failures ──────────────────────────────────────────────

  test("reports http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/token") ? tokenOk() : new Response("Server Error", { status: 500 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
  });

  test("reports parse_error → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) =>
      url.includes("/token") ? tokenOk() : new Response("garbage{", { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  test("happy path: indexes one dashboard with externalId powerbi:<id>", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/token")) return tokenOk();
      if (url.includes("/reports")) return reportsResponse([report("r1", "Sales")]);
      // datasets/{id}/tables
      return tablesResponse(["revenue"]);
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-powerbi1:");
    expectServiceItemCount(db, "powerbi", 1);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'powerbi'").get() as {
      external_id: string;
    } | null;
    expect(row?.external_id).toBe("powerbi:r1");
  });

  test("dataset tables are fetched and stored as upstreamDataModelKeys", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/token")) return tokenOk();
      if (url.includes("/reports")) return reportsResponse([report("r2", "Revenue", "d2")]);
      if (url.includes("/datasets/d2/tables")) return tablesResponse(["REVENUE_FACT"]);
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'powerbi'").get() as {
      metadata: string;
    } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["upstreamDataModelKeys"]).toEqual(["revenue_fact"]);
  });

  test("dataset tables fetch failure (http error) is tolerated — item still upserted", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/token")) return tokenOk();
      if (url.includes("/reports")) return reportsResponse([report("r3", "Dash", "d3")]);
      // tables endpoint fails
      return new Response("Forbidden", { status: 403 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'powerbi'").get() as {
      metadata: string;
    } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["upstreamDataModelKeys"]).toEqual([]);
  });

  test("empty reports list → success with zero upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/token")) return tokenOk();
      return reportsResponse([]);
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-powerbi1:");
  });

  test("cursor is nimbus-powerbi1: prefixed on success", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/token")) return tokenOk();
      return reportsResponse([]);
    });
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.cursor).toMatch(/^nimbus-powerbi1:/);
  });

  test("incoming cursor is preserved on token http_error", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Bad Gateway", { status: 502 }));
    const incomingCursor = "nimbus-powerbi1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS)),
      incomingCursor,
    );
    expect(r.cursor).toBe(incomingCursor);
    expect(r.itemsUpserted).toBe(0);
  });

  test("token POST uses form-encoded credentials with correct scope", async () => {
    const db = createMemoryIndexDb();
    let capturedBody = "";
    let capturedUrl = "";
    installFetch((url, init) => {
      if (url.includes("/token")) {
        capturedUrl = url;
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return tokenOk();
      }
      return reportsResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedUrl).toContain("my-tenant-id");
    expect(capturedBody).toContain("grant_type=client_credentials");
    expect(capturedBody).toContain("client_id=my-client-id");
    expect(capturedBody).toContain("client_secret=my-client-secret");
    expect(capturedBody).toContain("analysis.windows.net");
  });

  test("reports GET uses Bearer authorization header", async () => {
    const db = createMemoryIndexDb();
    let capturedAuthHeader = "";
    installFetch((url, init) => {
      if (url.includes("/token")) return tokenOk("my-bearer-token");
      capturedAuthHeader =
        (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      return reportsResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedAuthHeader).toBe("Bearer my-bearer-token");
  });
});
