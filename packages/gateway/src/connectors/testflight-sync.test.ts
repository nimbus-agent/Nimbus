import { expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createTestflightSyncable } from "./testflight-sync.ts";

/** Generate a PKCS#8 PEM for an EC P-256 key — matches what Apple requires. */
function generateP8Pem(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const TEST_PRIVATE_KEY_PEM = generateP8Pem();

/** Vault with all three TestFlight JWT credentials present. */
function credentialedVault() {
  return createStubVault({
    "testflight.issuer_id": "issuer-test-123",
    "testflight.key_id": "KEYTEST456",
    "testflight.private_key": TEST_PRIVATE_KEY_PEM,
  });
}

/** A minimal valid JSON:API app resource. */
function appResource(id: string, name: string, bundleId: string) {
  return {
    id,
    attributes: { name, bundleId, sku: "SKU001" },
  };
}

/** A minimal valid JSON:API build resource. */
function buildResource(buildId: string, version: string) {
  return {
    id: buildId,
    attributes: {
      version,
      processingState: "VALID",
      minOsVersion: "16.0",
      usesNonExemptEncryption: false,
      expired: false,
      uploadedDate: "2026-05-01T10:00:00.000Z",
    },
  };
}

describeWithFetchRestore("testflight-sync", () => {
  // ─── no-credential noop ────────────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when all credentials are missing",
    () => createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} }),
    createStubVault({
      "testflight.issuer_id": null,
      "testflight.key_id": null,
      "testflight.private_key": null,
    }),
  );

  testConnectorSyncNoop(
    "no-op when issuer_id is missing",
    () => createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} }),
    createStubVault({
      "testflight.issuer_id": null,
      "testflight.key_id": "KEYTEST456",
      "testflight.private_key": TEST_PRIVATE_KEY_PEM,
    }),
  );

  testConnectorSyncNoop(
    "no-op when key_id is missing",
    () => createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} }),
    createStubVault({
      "testflight.issuer_id": "issuer-test-123",
      "testflight.key_id": null,
      "testflight.private_key": TEST_PRIVATE_KEY_PEM,
    }),
  );

  testConnectorSyncNoop(
    "no-op when private_key is missing",
    () => createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} }),
    createStubVault({
      "testflight.issuer_id": "issuer-test-123",
      "testflight.key_id": "KEYTEST456",
      "testflight.private_key": null,
    }),
  );

  // ─── HTTP error on /v1/apps ────────────────────────────────────────────────
  test("returns empty result and advances cursor on /v1/apps HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("api.appstoreconnect.apple.com/v1/apps");
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // On http_error the incoming cursor (null) is kept or defaulted to pass1
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).not.toBeNull();
    expect(r.cursor).toContain("nimbus-testflight1:");
    expectServiceItemCount(db, "testflight", 0);
  });

  // ─── parse error on /v1/apps ───────────────────────────────────────────────
  test("returns empty result and advances cursor on /v1/apps parse error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("api.appstoreconnect.apple.com/v1/apps");
      return new Response("not valid json {{{{", { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-testflight1:");
    expectServiceItemCount(db, "testflight", 0);
  });

  // ─── /v1/apps returns non-array data (extractData branch: line 48) ─────────
  test("handles non-array data field in /v1/apps response gracefully", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("api.appstoreconnect.apple.com/v1/apps");
      // data is a plain object, not an array — exercises the !Array.isArray branch
      return new Response(JSON.stringify({ data: { id: "not-an-array" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-testflight1:");
    expectServiceItemCount(db, "testflight", 0);
  });

  // ─── app with missing id (resourceId returns undefined → continue) ─────────
  test("skips builds fetch for app entries missing an id field", async () => {
    const db = createMemoryIndexDb();
    let fetchCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      fetchCount += 1;
      if (u.includes("/v1/apps")) {
        // One valid app (has id), one without id
        return new Response(
          JSON.stringify({
            data: [
              appResource("app-001", "GoodApp", "com.example.good"),
              // no id field — exercises the id===undefined branch (line 112→continue)
              { attributes: { name: "NoIdApp", bundleId: "com.example.noid" } },
            ],
          }),
          { status: 200 },
        );
      }
      // /v1/builds for app-001
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // GoodApp is upserted as an app item; no id app is not upserted either (null from mapper)
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expect(r.cursor).toContain("nimbus-testflight1:");
    // Only one builds request (for app-001), not two
    expect(fetchCount).toBe(2);
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── app with empty string id (resourceId returns undefined → continue) ────
  test("skips builds fetch for app entries with empty-string id", async () => {
    const db = createMemoryIndexDb();
    let fetchCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      fetchCount += 1;
      if (u.includes("/v1/apps")) {
        return new Response(
          JSON.stringify({
            data: [
              // empty string id → resourceId returns undefined
              { id: "", attributes: { name: "EmptyIdApp", bundleId: "com.example.empty" } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // Empty-id app: mapTestflightAppToItem returns null (id=="" check) → not upserted;
    // and resourceId returns undefined → no builds fetch
    expect(r.itemsUpserted).toBe(0);
    expect(fetchCount).toBe(1); // only /v1/apps, no /v1/builds
    expectServiceItemCount(db, "testflight", 0);
  });

  // ─── builds HTTP error → skip builds, still count app upsert ──────────────
  test("skips builds that return a non-ok HTTP status (continues to next app)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        return new Response(
          JSON.stringify({ data: [appResource("app-001", "MyApp", "com.example.myapp")] }),
          { status: 200 },
        );
      }
      // builds request → HTTP error
      return new Response("Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // App was upserted, builds were skipped
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-testflight1:");
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── builds with null mapping (build entry lacking id → mapped===null) ─────
  test("skips builds that fail to map (missing build id) without crashing", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        return new Response(
          JSON.stringify({ data: [appResource("app-002", "TestApp", "com.example.test")] }),
          { status: 200 },
        );
      }
      // build entry with no id → mapTestflightBuildToItem returns null
      return new Response(
        JSON.stringify({
          data: [{ attributes: { version: "1.0", processingState: "VALID" } }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // app upserted, unmappable build skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── successful full sync: apps + builds ──────────────────────────────────
  test("indexes app and build items, advances cursor on successful sync", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        return new Response(
          JSON.stringify({
            data: [
              appResource("app-100", "FullApp", "com.example.full"),
              appResource("app-101", "BetaApp", "com.example.beta"),
            ],
          }),
          { status: 200 },
        );
      }
      if (u.includes("filter[app]=app-100")) {
        return new Response(JSON.stringify({ data: [buildResource("build-200", "2.0.1")] }), {
          status: 200,
        });
      }
      if (u.includes("filter[app]=app-101")) {
        return new Response(
          JSON.stringify({
            data: [buildResource("build-300", "3.0.0"), buildResource("build-301", "3.0.1")],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // 2 apps + 3 builds = 5 items
    expect(r.itemsUpserted).toBe(5);
    expect(r.cursor).toContain("nimbus-testflight1:");
    expectServiceItemCount(db, "testflight", 5);
  });

  // ─── app with no attributes (optional attribute fields → undefined) ────────
  test("indexes app with minimal attributes (name/bundleId absent)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        // attributes object present but no name/bundleId/sku
        return new Response(JSON.stringify({ data: [{ id: "app-minimal", attributes: {} }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // app-minimal has no name/bundleId but a valid id → falls back to id as title
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── app with null attributes key (asRecord returns undefined → fallback {}) ─
  test("handles app entry whose attributes key is null", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        // attributes is null → asRecord(null) = undefined → fallback {} in mapper
        return new Response(JSON.stringify({ data: [{ id: "app-nullattr", attributes: null }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── extractData: non-object entry inside data array ──────────────────────
  test("skips non-object entries inside the data array (extractData filter)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/apps") && !u.includes("filter[app]")) {
        return new Response(
          JSON.stringify({
            data: [
              // string + null entries exercise the `row = asRecord(entry); if undefined` branch (line 54)
              "not-an-object",
              null,
              appResource("app-999", "RealApp", "com.example.real"),
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    // Only the one valid app is indexed
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "testflight", 1);
  });

  // ─── /v1/apps returns null root (extractData: asRecord returns undefined) ──
  test("handles null-root /v1/apps response body without crashing", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("/v1/apps");
      // JSON null → asRecord returns undefined → root = {} → data undefined → not array
      return new Response(JSON.stringify(null), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, credentialedVault(), "testflight"), null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "testflight", 0);
  });

  // ─── http_error with existing cursor preserves incoming cursor ─────────────
  test("preserves non-null incoming cursor on HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Bad Gateway", { status: 502 });
    }) as unknown as typeof fetch;

    const sync = createTestflightSyncable({ ensureTestflightMcpRunning: async () => {} });
    const existingCursor = "nimbus-testflight1:some-prior-cursor";
    const r = await sync.sync(
      syncTestContext(db, credentialedVault(), "testflight"),
      existingCursor,
    );

    // syncPassCursorHttpEmpty returns incomingCursor ?? defaultCursor
    expect(r.cursor).toBe(existingCursor);
    expect(r.itemsUpserted).toBe(0);
  });
});
