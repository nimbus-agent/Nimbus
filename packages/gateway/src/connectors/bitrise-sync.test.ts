import { expect, test } from "bun:test";
import { createBitriseSyncable } from "./bitrise-sync.ts";
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

const NOOP_OPTIONS = { ensureBitriseMcpRunning: async () => {} };

function makeSyncable() {
  return createBitriseSyncable(NOOP_OPTIONS);
}

describeWithFetchRestore("bitrise-sync", () => {
  // --- no-credential noop (line 67-68) ---
  testConnectorSyncNoop(
    "no-op when API token missing",
    makeSyncable,
    createStubVault({ "bitrise.token": null }),
  );

  // --- apps endpoint http_error (lines 79-80) ---
  test("returns pass cursor on apps HTTP error response", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("Service Unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bitrise1:");
    expectServiceItemCount(db, "bitrise", 0);
  });

  // --- apps endpoint parse_error (lines 82-83) ---
  test("returns pass cursor on apps non-JSON response", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("not-json{{{{", { status: 200 });
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bitrise1:");
    expectServiceItemCount(db, "bitrise", 0);
  });

  // --- apps with no `data` array (lines 38-41): extractAppRows non-array branch ---
  test("handles apps response where data field is not an array", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ data: "not-an-array" }), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bitrise", 0);
  });

  // --- apps with non-object entry (line 46 false branch): asRecord(entry) === undefined ---
  test("skips non-object entries in apps data array", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (): Promise<Response> => {
      // data contains primitive values that cannot be converted to records
      return new Response(JSON.stringify({ data: ["not-an-object", 42, null] }), { status: 200 });
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bitrise", 0);
  });

  // --- app with empty slug: mapBitriseAppToItem returns null (line 93 null branch)
  //     AND appSlug returns undefined → continue without fetching builds (lines 98-99) ---
  test("skips app with empty slug (mappedApp null + no builds fetch)", async () => {
    const db = createMemoryIndexDb();
    let fetchCallCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCallCount += 1;
      // Only the apps call is made; no builds call for a slug-less app
      return new Response(
        JSON.stringify({
          data: [
            // app row with no slug field at all
            { title: "No-slug App", project_type: "ios" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    // Only the apps fetch was made
    expect(fetchCallCount).toBe(1);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bitrise", 0);
  });

  // --- builds endpoint non-ok (http_error) → continue (lines 108-109) ---
  test("continues past app when builds fetch returns HTTP error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/me/apps")) {
        return new Response(
          JSON.stringify({
            data: [{ slug: "app-abc", title: "My App" }],
          }),
          { status: 200 },
        );
      }
      // builds endpoint → http error
      return new Response("Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    // app is upserted; builds were skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "bitrise", 1);
  });

  // --- builds endpoint parse_error → continue (lines 108-109 via kind !== "ok") ---
  test("continues past app when builds fetch returns non-JSON", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/me/apps")) {
        return new Response(
          JSON.stringify({
            data: [{ slug: "app-xyz", title: "Another App" }],
          }),
          { status: 200 },
        );
      }
      return new Response("not-json{{", { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "bitrise", 1);
  });

  // --- build with no slug: mapBitriseBuildToItem returns null → continue (lines 113-114) ---
  test("skips build rows that have no slug", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/me/apps")) {
        return new Response(
          JSON.stringify({
            data: [{ slug: "app-slugged", title: "Slugged App" }],
          }),
          { status: 200 },
        );
      }
      // build rows: one valid, one missing slug
      return new Response(
        JSON.stringify({
          data: [
            {
              slug: "build-001",
              build_number: 1,
              triggered_workflow: "primary",
              branch: "main",
              status_text: "success",
              triggered_at: "2026-01-01T10:00:00.000Z",
            },
            {
              // no slug field → mapBitriseBuildToItem returns null → continue
              build_number: 2,
              triggered_workflow: "deploy",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    // 1 app + 1 valid build = 2 upserted
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "bitrise", 2);
  });

  // --- full happy path: app + builds upserted, cursor advanced ---
  test("indexes apps and builds and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/me/apps")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                slug: "my-app-slug",
                title: "My Bitrise App",
                project_type: "android",
                repo_url: "https://github.com/org/repo",
                default_branch_name: "main",
                is_disabled: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      // builds for my-app-slug
      return new Response(
        JSON.stringify({
          data: [
            {
              slug: "build-slug-1",
              build_number: 42,
              triggered_workflow: "ci",
              branch: "main",
              commit_hash: "abc123",
              commit_message: "feat: add bitrise",
              triggered_by: "webhook",
              status: 1,
              status_text: "success",
              triggered_at: "2026-01-15T08:00:00.000Z",
              started_on_worker_at: "2026-01-15T08:01:00.000Z",
              finished_at: "2026-01-15T08:10:00.000Z",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "tok-xyz" }), "bitrise"),
      null,
    );
    // 1 app + 1 build
    expect(r.itemsUpserted).toBe(2);
    expect(r.cursor).toContain("nimbus-bitrise1:");
    expectServiceItemCount(db, "bitrise", 2);

    // Verify app row type
    const appRow = db
      .prepare("SELECT type FROM item WHERE service = 'bitrise' AND external_id = 'my-app-slug'")
      .get() as { type: string } | undefined;
    expect(appRow?.type).toBe("app");

    // Verify build row type
    const buildRow = db
      .prepare(
        "SELECT type FROM item WHERE service = 'bitrise' AND external_id = 'my-app-slug/build-slug-1'",
      )
      .get() as { type: string } | undefined;
    expect(buildRow?.type).toBe("build");
  });

  // --- appSlug: empty string slug → undefined (line 55 true branch) ---
  test("skips builds fetch when app slug is empty string", async () => {
    const db = createMemoryIndexDb();
    let fetchCallCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCallCount += 1;
      return new Response(
        JSON.stringify({
          data: [{ slug: "", title: "Empty-slug App" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "bitrise.token": "test-token" }), "bitrise"),
      null,
    );
    // Only the apps call, no builds call
    expect(fetchCallCount).toBe(1);
    // mapBitriseAppToItem returns null for empty slug too → 0 upserted
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bitrise", 0);
  });
});
