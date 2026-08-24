import { expect, test } from "bun:test";

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
import { createLaunchdarklySyncable } from "./launchdarkly-sync.ts";

/** Minimal valid LaunchDarkly flags list response */
function makeFlagsResponse(flags: unknown[], totalCount = flags.length): string {
  return JSON.stringify({ items: flags, totalCount });
}

/** Minimal valid LaunchDarkly projects list response */
function makeProjectsResponse(projects: unknown[]): string {
  return JSON.stringify({ items: projects });
}

/** A fully-formed LaunchDarkly feature flag fixture */
const FULL_FLAG = {
  key: "my-flag",
  name: "My Flag",
  description: "A test flag",
  kind: "boolean",
  tags: ["team-a"],
  temporary: false,
  archived: false,
  creationDate: 1_700_000_000_000,
  variations: [{}, {}],
  environments: {
    production: { on: true, lastModified: 1_700_000_001_000 },
  },
};

describeWithFetchRestore("launchdarkly-sync", () => {
  // ─── No-op when token missing ───────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when API token missing",
    () => createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} }),
    createStubVault({ "launchdarkly.token": null }),
  );

  // ─── No-op when token is empty string ──────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when API token is empty string",
    () => createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} }),
    createStubVault({ "launchdarkly.token": "   " }),
  );

  // ─── Happy path: project_key set, flags indexed ─────────────────────────────
  test("indexes flags when project_key is set and flags returned", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("/api/v2/flags/my-project");
      return new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "my-project",
          "launchdarkly.base_url": "",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-launchdarkly1:");
    expectServiceItemCount(db, "launchdarkly", 1);
  });

  // ─── Custom base_url is used (line 46 non-empty branch) ────────────────────
  test("uses custom base_url when set", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
          "launchdarkly.base_url": "https://custom.ld.example",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(capturedUrl).toContain("https://custom.ld.example/api/v2/flags/proj");
  });

  // ─── Project list fetched when project_key is null ──────────────────────────
  test("fetches project list and then flags when project_key is absent", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      callCount += 1;
      if (u.includes("/projects")) {
        return new Response(makeProjectsResponse([{ key: "proj-a" }, { key: "proj-b" }]), {
          status: 200,
        });
      }
      return new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    // 1 projects call + 2 flags calls
    expect(callCount).toBe(3);
    // 1 flag per project = 2 total
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "launchdarkly", 2);
  });

  // ─── http_error resolving projects → syncPassCursorHttpEmpty (lines 166-167) ─
  test("returns http_error cursor when projects fetch returns non-ok HTTP", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    // No items indexed; cursor still advances
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "launchdarkly", 0);
    expect(r.cursor).toContain("nimbus-launchdarkly1:");
  });

  // ─── parse_error resolving projects → syncPassCursorParseEmpty (line 123 false-branch) ─
  test("returns parse_error cursor when projects fetch returns invalid JSON", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not-json", { status: 200 }))) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "launchdarkly", 0);
    expect(r.cursor).toContain("nimbus-launchdarkly1:");
  });

  // ─── http_error on flags fetch → loop breaks (line 139-141) ────────────────
  test("stops fetching when flags page returns http_error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Server Error", { status: 500 }))) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "launchdarkly", 0);
  });

  // ─── parse_error on flags fetch → loop breaks ──────────────────────────────
  test("stops fetching when flags page returns parse_error (invalid JSON)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("totally-not-json", { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── Empty flags array → zero upserts ─────────────────────────────────────
  test("handles empty flags list without error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFlagsResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "launchdarkly", 0);
  });

  // ─── Pagination: full page triggers next page fetch (line 144) ──────────────
  test("fetches next page when result is exactly PAGE_SIZE (100)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    // Build 100 valid flags
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      key: `flag-${i}`,
      name: `Flag ${i}`,
      kind: "boolean",
    }));

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      callCount += 1;
      const u = urlFromFetchInput(input);
      if (callCount === 1) {
        // First page — full, should trigger second call
        expect(u).toContain("offset=0");
        return new Response(makeFlagsResponse(fullPage), { status: 200 });
      }
      // Second page — empty, terminates loop
      expect(u).toContain("offset=100");
      return new Response(makeFlagsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(100);
    expectServiceItemCount(db, "launchdarkly", 100);
  });

  // ─── Flag missing required "key" → skipped (mapped === null, lines 101-102) ─
  test("skips flags where mapLaunchDarklyFlagToItem returns null (missing key)", async () => {
    const db = createMemoryIndexDb();
    const flags = [
      { name: "No Key Flag" }, // missing "key" → mapLaunchDarklyFlagToItem returns null
      FULL_FLAG, // valid
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFlagsResponse(flags), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    // Only FULL_FLAG is indexed
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "launchdarkly", 1);
  });

  // ─── Non-record flag in items array → mapLaunchDarklyFlagToItem returns null ─
  test("skips non-object flag entries in items array (mapped === null)", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({ items: ["not-an-object", null, 42, FULL_FLAG] });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "launchdarkly", 1);
  });

  // ─── extractItems: parsed is not a record (line 58 ?? {} branch) ────────────
  test("handles response where parsed is not an object (items defaults to [])", async () => {
    const db = createMemoryIndexDb();
    // Valid JSON but not an object — parsed = array → asRecord returns undefined → {}
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([1, 2, 3]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── extractItems: root["items"] is not an array (line 60 false branch) ─────
  test("handles response where items field is not an array", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: "not-an-array" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── extractProjectKeys: non-record project → skipped (lines 67-68) ─────────
  test("skips non-record project entries in project list", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/projects")) {
        // Mix: one non-record, one missing key, one valid
        return new Response(
          makeProjectsResponse(["not-a-record", { key: "" }, { key: "valid-proj" }]),
          { status: 200 },
        );
      }
      return new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    // Only "valid-proj" passes; the non-record and empty-key are skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "launchdarkly", 1);
  });

  // ─── extractProjectKeys: key is empty string → skipped (line 71 false branch) ─
  test("skips projects with empty-string key in project list", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/projects")) {
        return new Response(makeProjectsResponse([{ key: "" }, { key: "real-proj" }]), {
          status: 200,
        });
      }
      return new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "launchdarkly", 1);
  });

  // ─── cursor advances on zero flags (empty project list) ─────────────────────
  test("returns success cursor even when project list is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/projects")) {
        return new Response(makeProjectsResponse([]), { status: 200 });
      }
      return new Response(makeFlagsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": null,
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-launchdarkly1:");
  });

  // ─── Existing cursor passes through on re-sync ──────────────────────────────
  test("resumes with existing cursor and returns updated cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 }),
      )) as unknown as typeof fetch;

    const existingCursor =
      "nimbus-launchdarkly1:" +
      Buffer.from(JSON.stringify({ pass: 1 }), "utf8").toString("base64url");

    const sync = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      existingCursor,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-launchdarkly1:");
  });

  // ─── ensureLaunchdarklyMcpRunning is called on each sync ────────────────────
  test("calls ensureLaunchdarklyMcpRunning before syncing", async () => {
    const db = createMemoryIndexDb();
    let mcpCalled = false;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeFlagsResponse([FULL_FLAG]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createLaunchdarklySyncable({
      ensureLaunchdarklyMcpRunning: async () => {
        mcpCalled = true;
      },
    });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "launchdarkly.token": "sdk-test",
          "launchdarkly.project_key": "proj",
        }),
        "launchdarkly",
      ),
      null,
    );
    expect(mcpCalled).toBe(true);
  });
});
