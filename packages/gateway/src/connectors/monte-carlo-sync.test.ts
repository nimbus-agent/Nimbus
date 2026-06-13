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
import { createMonteCarloSyncable } from "./monte-carlo-sync.ts";

const FULL_CREDS = {
  "montecarlo.api_id": "test-api-id",
  "montecarlo.api_token": "test-api-token",
};

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function graphqlResponse(incidents: Record<string, unknown>[]): Response {
  return new Response(
    JSON.stringify({
      data: {
        getIncidents: {
          edges: incidents.map((node) => ({ node })),
        },
      },
    }),
    { status: 200 },
  );
}

function makeSyncable() {
  return createMonteCarloSyncable({ ensureMonteCarloMcpRunning: async () => {} });
}

describeWithFetchRestore("monte-carlo-sync", () => {
  // ─── No-op when credentials are missing ────────────────────────────────────

  test("no-op when api_id is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "montecarlo.api_token": "tok" })),
      null,
    );
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "montecarlo", 0);
  });

  test("no-op when api_token is missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault({ "montecarlo.api_id": "id" })),
      null,
    );
    expectSyncNoopResult(r);
  });

  test("no-op when both credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault({})), null);
    expectSyncNoopResult(r);
  });

  // ─── HTTP / parse errors ────────────────────────────────────────────────────

  test("http_error → http-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-montecarlo1:");
    expectServiceItemCount(db, "montecarlo", 0);
  });

  test("parse_error (invalid JSON) → parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-json{", { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-montecarlo1:");
  });

  test("incoming cursor is preserved on http_error", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Bad Gateway", { status: 502 }));
    const incomingCursor = "nimbus-montecarlo1:oldcursor";
    const r = await makeSyncable().sync(
      syncTestContext(db, createStubVault(FULL_CREDS)),
      incomingCursor,
    );
    expect(r.cursor).toBe(incomingCursor);
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  test("happy path: indexes one incident with externalId montecarlo:42", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      graphqlResponse([
        {
          incidentId: "42",
          monitoredTable: "ANALYTICS.PUBLIC.REVENUE",
          status: "open",
          severity: "high",
        },
      ]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-montecarlo1:");
    expectServiceItemCount(db, "montecarlo", 1);
    const row = db.prepare("SELECT external_id FROM item WHERE service = 'montecarlo'").get() as {
      external_id: string;
    } | null;
    expect(row?.external_id).toBe("montecarlo:42");
  });

  test("monitoredDataModelKeys is stored normalized in metadata", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      graphqlResponse([
        {
          incidentId: "42",
          monitoredTable: "ANALYTICS.PUBLIC.REVENUE",
          status: "open",
          severity: "high",
        },
      ]),
    );
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    const row = db.prepare("SELECT metadata FROM item WHERE service = 'montecarlo'").get() as {
      metadata: string;
    } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual(["analytics.public.revenue"]);
  });

  test("empty incident list → success with zero upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => graphqlResponse([]));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-montecarlo1:");
  });

  test("cursor is nimbus-montecarlo1: prefixed on success", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => graphqlResponse([]));
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.cursor).toMatch(/^nimbus-montecarlo1:/);
  });

  test("POST uses x-mcd-id and x-mcd-token headers", async () => {
    const db = createMemoryIndexDb();
    let capturedHeaders: Record<string, string> = {};
    installFetch((_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
      return graphqlResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedHeaders["x-mcd-id"]).toBe("test-api-id");
    expect(capturedHeaders["x-mcd-token"]).toBe("test-api-token");
  });

  test("POST sends application/json body to the GraphQL endpoint", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    let capturedBody = "";
    installFetch((url, init) => {
      capturedUrl = url;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return graphqlResponse([]);
    });
    await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(capturedUrl).toBe("https://api.getmontecarlo.com/graphql");
    expect(() => JSON.parse(capturedBody)).not.toThrow();
    const body = JSON.parse(capturedBody) as { query: string };
    expect(body.query).toContain("getIncidents");
  });

  test("incidents missing incidentId are skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch(() =>
      graphqlResponse([
        { status: "open" }, // no incidentId → skipped
        { incidentId: "5", status: "fixed" },
      ]),
    );
    const r = await makeSyncable().sync(syncTestContext(db, createStubVault(FULL_CREDS)), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "montecarlo", 1);
  });
});
