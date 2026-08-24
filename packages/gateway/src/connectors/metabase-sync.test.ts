import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createMetabaseSyncable } from "./metabase-sync.ts";

const NO_OP_OPTIONS = { ensureMetabaseMcpRunning: async (): Promise<void> => {} };

/** Minimal valid dashboard fixture. */
const FULL_DASHBOARD = {
  id: 1,
  name: "Sales Overview",
  description: "Top-level sales KPIs",
  collection_id: 10,
  creator_id: 42,
  created_at: "2026-05-01T10:00:00.000Z",
  updated_at: "2026-06-01T12:00:00.000Z",
  archived: false,
  dashcards: [{ id: 100 }, { id: 101 }],
};

/** Stub collections list (array response shape — covers extractArray array branch, line 52). */
function makeCollectionsArray(): unknown[] {
  return [
    { id: 10, name: "Marketing" },
    { id: 11, name: "Engineering" },
  ];
}

/** Stub dashboards list. */
function makeDashboardsResponse(items: unknown[]): string {
  return JSON.stringify(items);
}

/** Build a URL→response map used by the multi-endpoint fetch stub. */
type FakeResponses = Record<string, { status: number; body: string }>;

function makeFetchStub(responses: FakeResponses): typeof fetch {
  return (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(resp.body, { status: resp.status });
      }
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describeWithFetchRestore("metabase-sync", () => {
  // ── no-op: missing credentials ─────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when url is missing",
    () => createMetabaseSyncable(NO_OP_OPTIONS),
    createStubVault({ "metabase.url": null, "metabase.api_key": "key" }),
  );

  testConnectorSyncNoop(
    "no-op when api_key is missing",
    () => createMetabaseSyncable(NO_OP_OPTIONS),
    createStubVault({ "metabase.url": "https://mb.example.com", "metabase.api_key": null }),
  );

  testConnectorSyncNoop(
    "no-op when both credentials are missing",
    () => createMetabaseSyncable(NO_OP_OPTIONS),
    createStubVault({ "metabase.url": null, "metabase.api_key": null }),
  );

  // ── happy path: valid credentials, full dashboard response ─────────────────
  test("indexes dashboards from array response and advances cursor", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify(makeCollectionsArray()),
      },
      "/api/dashboard": {
        status: 200,
        body: makeDashboardsResponse([FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-metabase1:");
    expectServiceItemCount(db, "metabase", 1);
  });

  // ── trimTrailingSlash: URL with trailing slash (line 33 true branch) ────────
  test("trims trailing slash from base URL before fetching", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com/",
      "metabase.api_key": "test-api-key",
    });

    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      if (url.includes("/api/collection")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([FULL_DASHBOARD]), { status: 200 });
    }) as typeof fetch;

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    await sync.sync(syncTestContext(db, vault, "metabase"), null);

    // None of the URLs should have a double slash (// after the host)
    for (const u of seenUrls) {
      expect(u).not.toContain("com//api");
    }
    expect(seenUrls.some((u) => u.endsWith("/api/collection"))).toBe(true);
  });

  // ── trimTrailingSlash: URL without trailing slash (line 33 false branch) ────
  test("preserves URL without trailing slash", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 200, body: JSON.stringify([FULL_DASHBOARD]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractArray: dashboards response is a {data:[…]} object (line 52 false branch, line 55-56) ──
  test("extracts dashboards from {data:[…]} object shape", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify({ data: [FULL_DASHBOARD] }),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "metabase", 1);
  });

  // ── extractArray: {data:…} where data is NOT an array → empty (line 56 false-branch) ──
  test("returns empty list when {data:…} value is not an array", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify({ data: "not-an-array" }),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "metabase", 0);
  });

  // ── extractCollectionNames: non-record entry in collections → skipped (line 63-64) ──
  test("skips non-object entries in collections list", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    // Mix of a primitive (skipped) and a valid collection
    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify(["not-a-record", { id: 10, name: "Marketing" }]),
      },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([
          {
            ...FULL_DASHBOARD,
            collection_id: 10,
          },
        ]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    // Dashboard with collection_id=10 still gets indexed (collection name resolved)
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractCollectionNames: numeric id (line 68 false-branch → String(idNum)) ──
  test("resolves collection name when collection id is numeric", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify([{ id: 99, name: "Finance" }]),
      },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([{ ...FULL_DASHBOARD, id: 5, collection_id: 99 }]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractCollectionNames: string id (line 68 true-branch → idStr ?? "") ──
  test("resolves collection name when collection id is a string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify([{ id: "root", name: "Root Collection" }]),
      },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([{ ...FULL_DASHBOARD, id: 6, collection_id: "root" }]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractCollectionNames: empty key → not added to map (line 70 false-branch) ──
  test("omits collection entry when key is empty string", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    // id is neither number nor non-empty string → key="" → skipped
    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify([{ id: "", name: "Ghost Collection" }]),
      },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    // Dashboard still indexed even without collection name
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractCollectionNames: name absent → not added (line 70 false-branch) ──
  test("omits collection entry when name field is absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": {
        status: 200,
        body: JSON.stringify([{ id: 10 }]), // no name field
      },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── upsertDashboards: mapped === null → skipped (line 91, DA=0 exec line 92) ──
  test("skips dashboard items that fail mapping (no id field → mapped null)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    // Missing id → mapMetabaseDashboardToItem returns null
    const invalidDash = { name: "No ID Dashboard" };
    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([invalidDash, FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    // Only the valid dashboard gets upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "metabase", 1);
  });

  // ── upsertDashboards: dashboard with no name → mapped null → skipped ────────
  test("skips dashboard with empty name (mapped null)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    const noNameDash = { id: 200, name: "" };
    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify([noNameDash, FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── outcome.kind === "http_error" → syncPassCursorHttpEmpty (line 121 true-branch) ──
  test("returns http_error result when dashboard endpoint returns 500", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 500, body: "Internal Server Error" },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-metabase1:");
    expectServiceItemCount(db, "metabase", 0);
  });

  // ── outcome.kind === "parse_error" → syncPassCursorParseEmpty (line 121 false-branch, line 123) ──
  test("returns parse_error result when dashboard endpoint returns invalid JSON", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 200, body: "not-valid-json{{" },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-metabase1:");
    expectServiceItemCount(db, "metabase", 0);
  });

  // ── empty dashboard list → zero upserted, cursor advances ──────────────────
  test("returns zero upserted when dashboard list is empty", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 200, body: JSON.stringify([]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-metabase1:");
  });

  // ── collections endpoint http_error → collectionNames falls back to {} ──────
  test("proceeds with empty collection names when collections endpoint returns 500", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 500, body: "Error" },
      "/api/dashboard": { status: 200, body: JSON.stringify([FULL_DASHBOARD]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    // Dashboard still indexed even without collection names
    expect(r.itemsUpserted).toBe(1);
  });

  // ── collections endpoint parse_error → collectionNames falls back to {} ─────
  test("proceeds with empty collection names when collections endpoint returns invalid JSON", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: "not-json{{" },
      "/api/dashboard": { status: 200, body: JSON.stringify([FULL_DASHBOARD]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── non-record dashboard in list → skipped by mapping (line 91, DA=0 exec 92) ──
  test("skips non-object dashboard entries (primitive in array)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": {
        status: 200,
        body: JSON.stringify(["primitive-entry", null, FULL_DASHBOARD]),
      },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "metabase", 1);
  });

  // ── cursor is passed back in from a prior sync (non-null cursor input) ──────
  test("sync accepts a non-null prior cursor and still indexes dashboards", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 200, body: JSON.stringify([FULL_DASHBOARD]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    // First run to get a cursor
    const r1 = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r1.cursor).toContain("nimbus-metabase1:");

    // Second run with the prior cursor
    const r2 = await sync.sync(syncTestContext(db, vault, "metabase"), r1.cursor);
    expect(r2.itemsUpserted).toBe(1);
    expect(r2.cursor).toContain("nimbus-metabase1:");
  });

  // ── dashboard optional-field fallbacks (modifiedAt falls back to syncedAt) ──
  test("uses syncedAt as modifiedAt when both created_at and updated_at are absent", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "metabase.url": "https://mb.example.com",
      "metabase.api_key": "test-api-key",
    });

    // No dates at all
    const noDateDash = { id: 7, name: "No Dates" };
    globalThis.fetch = makeFetchStub({
      "/api/collection": { status: 200, body: JSON.stringify([]) },
      "/api/dashboard": { status: 200, body: JSON.stringify([noDateDash]) },
    });

    const sync = createMetabaseSyncable(NO_OP_OPTIONS);
    const r = await sync.sync(syncTestContext(db, vault, "metabase"), null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'metabase' AND external_id = '7'")
      .get() as { modified_at: number } | undefined;
    expect(row?.modified_at).toBeGreaterThan(Date.now() - 5000);
  });
});
