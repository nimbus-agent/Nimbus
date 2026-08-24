import { expect, test } from "bun:test";
import { createCodemagicSyncable } from "./codemagic-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";

const VALID_TOKEN_VAULT = createStubVault({ "codemagic.token": "cm_test_token" });

type FetchHandler = (url: string, init: SyncTestFetchParams[1]) => Response;

function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (
    input: SyncTestFetchParams[0],
    init?: SyncTestFetchParams[1],
  ): Promise<Response> => handler(urlFromFetchInput(input), init)) as typeof fetch;
}

function makeSyncable() {
  return createCodemagicSyncable({ ensureCodemagicMcpRunning: async () => {} });
}

/** Minimal valid app fixture with an _id so builds can be fetched. */
function makeApp(id: string, name = `App-${id}`): Record<string, unknown> {
  return { _id: id, appName: name };
}

/** Minimal valid build fixture. */
function makeBuild(id: string): Record<string, unknown> {
  return {
    _id: id,
    workflowId: "default",
    branch: "main",
    status: "finished",
    startedAt: "2026-04-01T10:00:00.000Z",
    finishedAt: "2026-04-01T10:05:00.000Z",
  };
}

describeWithFetchRestore("codemagic-sync", () => {
  // ── no-op (missing API key) ─────────────────────────────────────────────────
  testConnectorSyncNoop("no-op when token is missing", makeSyncable, EMPTY_NIMBUS_VAULT);

  testConnectorSyncNoop(
    "no-op when token is blank (whitespace-only)",
    makeSyncable,
    createStubVault({ "codemagic.token": "   " }),
  );

  // ── apps endpoint: http_error (line 74/75) ──────────────────────────────────
  test("apps http_error → returns pass cursor with 0 upserts", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Unauthorized", { status: 401 }));
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-codemagic1:");
    expectServiceItemCount(db, "codemagic", 0);
  });

  // ── apps endpoint: http_error with existing cursor preserved ────────────────
  test("apps http_error preserves incoming cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("Service Unavailable", { status: 503 }));
    const existing = "nimbus-codemagic1:existing";
    const r = await makeSyncable().sync(
      syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"),
      existing,
    );
    expect(r.cursor).toBe(existing);
    expect(r.itemsUpserted).toBe(0);
  });

  // ── apps endpoint: parse_error (line 77/78) ─────────────────────────────────
  test("apps parse_error → returns parse-empty pass cursor", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response("not-valid-json{{", { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-codemagic1:");
    expectServiceItemCount(db, "codemagic", 0);
  });

  // ── extractRows: non-array key (lines 38/40/41) ─────────────────────────────
  test("apps response with non-array 'applications' key → 0 app rows", async () => {
    const db = createMemoryIndexDb();
    // "applications" is a string, not an array — extractRows returns []
    installFetch(
      () => new Response(JSON.stringify({ applications: "not-an-array" }), { status: 200 }),
    );
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-codemagic1:");
    expectServiceItemCount(db, "codemagic", 0);
  });

  // ── extractRows: non-record entry in array (line 46 false arm) ──────────────
  test("app array entries that are not records are skipped", async () => {
    const db = createMemoryIndexDb();
    // Mix of a valid app, a primitive (number), and null — only the valid app upserts
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(
          JSON.stringify({ applications: [makeApp("app1"), 42, null, makeApp("app2")] }),
          { status: 200 },
        );
      }
      // builds endpoint: empty builds
      return new Response(JSON.stringify({ builds: [] }), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // app1 and app2 are valid; 42 and null are skipped by extractRows
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "codemagic", 2);
  });

  // ── appId: empty string (line 55 true arm "id === ''") ─────────────────────
  test("app with empty _id is skipped by appId() (no builds fetch for it)", async () => {
    const db = createMemoryIndexDb();
    let buildsFetched = false;
    installFetch((url) => {
      if (url.includes("/builds")) {
        buildsFetched = true;
        return new Response(JSON.stringify({ builds: [] }), { status: 200 });
      }
      // App has _id="" — mapCodemagicAppToItem returns null, and appId() returns undefined
      return new Response(JSON.stringify({ applications: [{ _id: "", appName: "NoId" }] }), {
        status: 200,
      });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    // builds endpoint should NOT be called since appId is ""
    expect(buildsFetched).toBe(false);
    expectServiceItemCount(db, "codemagic", 0);
  });

  // ── mappedApp === null branch (line 88 false arm) ───────────────────────────
  test("app with missing _id is not upserted and does not trigger builds fetch", async () => {
    // mapCodemagicAppToItem returns null when _id is missing from the raw row;
    // however appId() checks the SAME row — if _id is absent stringField returns
    // undefined, so appId() returns undefined and we never fetch builds either.
    // This test confirms both null-map AND undefined-appId branches are hit together.
    const db = createMemoryIndexDb();
    let buildsFetched = false;
    installFetch((url) => {
      if (url.includes("/builds")) {
        buildsFetched = true;
        return new Response(JSON.stringify({ builds: [] }), { status: 200 });
      }
      // _id absent → mapCodemagicAppToItem null + appId undefined
      return new Response(JSON.stringify({ applications: [{ appName: "NoId" }] }), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(buildsFetched).toBe(false);
    expectServiceItemCount(db, "codemagic", 0);
  });

  // ── builds http_error (line 103 true arm) ───────────────────────────────────
  test("builds fetch http_error → app is upserted, build is skipped (continue)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp("app42")] }), { status: 200 });
      }
      // builds endpoint → HTTP error
      return new Response("Internal Server Error", { status: 500 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // app42 was upserted, but the build fetch failed → only 1 item
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "codemagic", 1);
    expect(r.cursor).toContain("nimbus-codemagic1:");
  });

  // ── builds parse_error (line 103 true arm via kind !== "ok") ────────────────
  test("builds fetch parse_error → app is upserted, build is skipped (continue)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp("app43")] }), { status: 200 });
      }
      // builds endpoint → invalid JSON
      return new Response("{{invalid", { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "codemagic", 1);
  });

  // ── mapped build === null (line 108 true arm) ────────────────────────────────
  test("build with missing _id is skipped (mapped === null)", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp("appX")] }), { status: 200 });
      }
      // Builds list: one unmappable (no _id) + one valid
      return new Response(
        JSON.stringify({
          builds: [
            { workflowId: "w", branch: "main", status: "finished" }, // missing _id
            makeBuild("bld1"),
          ],
        }),
        { status: 200 },
      );
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // app + 1 valid build (unmappable skipped)
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "codemagic", 2);
  });

  // ── happy path: app + multiple builds ────────────────────────────────────────
  test("happy path: indexes app and builds, advances cursor", async () => {
    const db = createMemoryIndexDb();
    const appId = "app-happy";
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp(appId, "HappyApp")] }), {
          status: 200,
        });
      }
      expect(url).toContain(`appId=${encodeURIComponent(appId)}`);
      return new Response(JSON.stringify({ builds: [makeBuild("b1"), makeBuild("b2")] }), {
        status: 200,
      });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // 1 app + 2 builds
    expect(r.itemsUpserted).toBe(3);
    expect(r.cursor).toContain("nimbus-codemagic1:");
    expectServiceItemCount(db, "codemagic", 3);
  });

  // ── happy path: multiple apps each with builds ────────────────────────────────
  test("indexes multiple apps and their builds", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp("app1"), makeApp("app2")] }), {
          status: 200,
        });
      }
      // Return 1 build per app
      return new Response(JSON.stringify({ builds: [makeBuild("bld-x")] }), { status: 200 });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // 2 apps + 2 builds = 4
    expect(r.itemsUpserted).toBe(4);
    expectServiceItemCount(db, "codemagic", 4);
  });

  // ── builds array with non-record entries (line 46 false arm via builds) ──────
  test("builds array entries that are not records are skipped", async () => {
    const db = createMemoryIndexDb();
    installFetch((url) => {
      if (url.includes("/apps")) {
        return new Response(JSON.stringify({ applications: [makeApp("appZ")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ builds: [makeBuild("bZ1"), "not-a-record", 99] }), {
        status: 200,
      });
    });
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    // app + 1 valid build (2 non-record skipped)
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "codemagic", 2);
  });

  // ── extractRows with null parsed (asRecord returns undefined → ?? {}) ────────
  test("null parsed body → asRecord returns undefined → ?? {} → empty rows", async () => {
    const db = createMemoryIndexDb();
    installFetch(() => new Response(JSON.stringify(null), { status: 200 }));
    const r = await makeSyncable().sync(syncTestContext(db, VALID_TOKEN_VAULT, "codemagic"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "codemagic", 0);
  });
});
