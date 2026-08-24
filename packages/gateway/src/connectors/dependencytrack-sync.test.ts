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
import { createDependencytrackSyncable } from "./dependencytrack-sync.ts";

const BASE_URL = "https://dt.example.com";
const API_KEY = "dt-api-key-test";

function makeDTSyncable() {
  return createDependencytrackSyncable({ ensureDependencytrackMcpRunning: async () => {} });
}

function makeStubVault(baseUrl: string | null = BASE_URL, apiKey: string | null = API_KEY) {
  return createStubVault({
    "dependencytrack.base_url": baseUrl,
    "dependencytrack.api_key": apiKey,
  });
}

/** Build a minimal DependencyTrack project fixture */
function makeProject(overrides: Record<string, unknown> = {}): unknown {
  return {
    uuid: "aaaaaaaa-0000-0000-0000-000000000001",
    name: "my-project",
    version: "1.0.0",
    active: true,
    ...overrides,
  };
}

/** Serialize a project-list response */
function makeProjectsBody(projects: unknown[]): string {
  return JSON.stringify(projects);
}

describeWithFetchRestore("dependencytrack-sync", () => {
  // ─── no-op when base_url missing ─────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when base_url is missing",
    makeDTSyncable,
    makeStubVault(null, API_KEY),
  );

  // ─── no-op when api_key missing ───────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when api_key is missing",
    makeDTSyncable,
    makeStubVault(BASE_URL, null),
  );

  // ─── no-op when both credentials missing ──────────────────────────────────
  testConnectorSyncNoop(
    "no-op when both credentials are missing",
    makeDTSyncable,
    makeStubVault(null, null),
  );

  // ─── line 34: trimTrailingSlash true branch — base_url with trailing slash ──
  test("trims trailing slash from base_url (line-34 true branch)", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeProjectsBody([makeProject()]), { status: 200 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    // Pass base_url WITH trailing slash — trimTrailingSlash takes the s.slice branch
    const r = await sync.sync(
      syncTestContext(db, makeStubVault(`${BASE_URL}/`, API_KEY), "dependencytrack"),
      null,
    );
    expect(capturedUrl).not.toContain("//api"); // no double-slash
    expect(capturedUrl).toContain(BASE_URL);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── line 34: trimTrailingSlash false branch — base_url without trailing slash ──
  test("keeps base_url unchanged when no trailing slash (line-34 false branch)", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeProjectsBody([makeProject()]), { status: 200 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(
      syncTestContext(db, makeStubVault(BASE_URL, API_KEY), "dependencytrack"),
      null,
    );
    expect(capturedUrl).toContain(BASE_URL);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── happy path: indexes projects and advances cursor ─────────────────────
  test("indexes projects from response and returns cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody([makeProject()]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
    expectServiceItemCount(db, "dependencytrack", 1);
  });

  // ─── happy path: X-Api-Key header is set ─────────────────────────────────
  test("sends X-Api-Key header with the configured API key", async () => {
    const db = createMemoryIndexDb();
    let capturedKey = "";

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedKey = headers?.["X-Api-Key"] ?? "";
      return new Response(makeProjectsBody([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(capturedKey).toBe(API_KEY);
  });

  // ─── line 63: extractProjects false branch — parsed is not an array ───────
  test("treats non-array parsed body as empty list (line-63 false branch)", async () => {
    const db = createMemoryIndexDb();

    // Return a JSON object (not an array) — extractProjects returns []
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ not: "an array" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "dependencytrack", 0);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── empty results: stops on short page ───────────────────────────────────
  test("stops pagination on empty page and returns cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── line 75+76: upsertProjects — mapped === null (continue) ─────────────
  // A project missing its uuid → mapDependencyTrackProjectToItem returns null → continue
  test("skips projects that fail mapping (missing uuid) — covers line-75 continue", async () => {
    const db = createMemoryIndexDb();

    const projects = [
      { name: "no-uuid-project", active: true }, // uuid missing → mapped = null
      makeProject(), // valid
    ];

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody(projects), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    // Only the valid project is upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dependencytrack", 1);
  });

  // ─── line 75+76: project missing name → also null mapping ────────────────
  test("skips projects that fail mapping (missing name)", async () => {
    const db = createMemoryIndexDb();

    const projects = [
      { uuid: "bbbbbbbb-0000-0000-0000-000000000002", active: true }, // name missing → null
    ];

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody(projects), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "dependencytrack", 0);
  });

  // ─── line 75+76: non-object element in array → asRecord returns undefined → null ──
  test("skips non-object elements in projects array (primitive entry)", async () => {
    const db = createMemoryIndexDb();

    const projects = ["not-a-record", makeProject()];

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody(projects), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── line 107 false branch: http_error on page > 1 → break (line 112) ────
  test("breaks out of loop on http_error after first page (lines 107-112)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    // PAGE_SIZE = 100; return 100 items on page 1 → loop continues; 500 on page 2 → break
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeProject({
        uuid: `cccccccc-0000-0000-0000-${String(i).padStart(12, "0")}`,
        name: `project-${i}`,
      }),
    );

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(makeProjectsBody(fullPage), { status: 200 });
      }
      // page 2: http_error → line 107 false branch → break
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(callCount).toBe(2);
    // Page 1 upserted all 100 items; page 2 errored → break → returns success cursor
    expect(r.itemsUpserted).toBe(100);
    expectServiceItemCount(db, "dependencytrack", 100);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── line 108 false branch: parse_error on page 1 → syncPassCursorParseEmpty ──
  test("returns parse-empty cursor on parse_error on first page (line-108 false branch)", async () => {
    const db = createMemoryIndexDb();

    // ok=true but body is not valid JSON → parse_error
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-valid-json{{{{", { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(0);
    // syncPassCursorParseEmpty always uses the defaultCursor (pass1Cursor), never null
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── line 107+108 true branch: http_error on page 1 → syncPassCursorHttpEmpty ──
  test("returns http-empty cursor on http_error on first page (line-108 true branch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Server Error", { status: 500 }))) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(0);
    // syncPassCursorHttpEmpty preserves the incoming cursor (null → defaultCursor)
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── http_error page 1 with existing cursor → cursor preserved ───────────
  test("http_error on page 1 preserves the incoming cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const existingCursor = "nimbus-dependencytrack1:some-cursor";
    const r = await sync.sync(
      syncTestContext(db, makeStubVault(), "dependencytrack"),
      existingCursor,
    );
    expect(r.itemsUpserted).toBe(0);
    // syncPassCursorHttpEmpty: incomingCursor ?? defaultCursor → returns existingCursor
    expect(r.cursor).toBe(existingCursor);
  });

  // ─── parse_error on page > 1 → break (line-112 exec) ─────────────────────
  test("breaks on parse_error after first page", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeProject({
        uuid: `dddddddd-0000-0000-0000-${String(i).padStart(12, "0")}`,
        name: `project-p2-${i}`,
      }),
    );

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(makeProjectsBody(fullPage), { status: 200 });
      }
      // page 2: ok=true but non-JSON → parse_error → line 107 false branch → break
      return new Response("not-json{{", { status: 200 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(100);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });

  // ─── pagination stops on short page (< PAGE_SIZE) ─────────────────────────
  test("stops pagination when page returns fewer than 100 items", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      // Return 3 items on page 1 → projects.length < PAGE_SIZE → break
      return new Response(
        makeProjectsBody([
          makeProject({ uuid: "eeeeeeee-0000-0000-0000-000000000001", name: "proj-a" }),
          makeProject({ uuid: "eeeeeeee-0000-0000-0000-000000000002", name: "proj-b" }),
          makeProject({ uuid: "eeeeeeee-0000-0000-0000-000000000003", name: "proj-c" }),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "dependencytrack", 3);
  });

  // ─── optional fields: project without version ─────────────────────────────
  test("handles project without version field (optional-field fallback)", async () => {
    const db = createMemoryIndexDb();

    const proj = makeProject({ version: undefined });

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody([proj]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dependencytrack", 1);
  });

  // ─── optional fields: project with tags ───────────────────────────────────
  test("handles project with tags array", async () => {
    const db = createMemoryIndexDb();

    const proj = makeProject({
      tags: [{ name: "production" }, { name: "java" }],
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody([proj]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── optional fields: project with metrics ────────────────────────────────
  test("handles project with metrics object", async () => {
    const db = createMemoryIndexDb();

    const proj = makeProject({
      metrics: { critical: 2, high: 5, medium: 10, low: 3, vulnerabilities: 20, components: 50 },
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeProjectsBody([proj]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── multi-page happy path ─────────────────────────────────────────────────
  test("fetches multiple pages and accumulates upserted count", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeProject({
        uuid: `ffffffff-0001-0000-0000-${String(i).padStart(12, "0")}`,
        name: `page1-proj-${i}`,
      }),
    );
    const page2 = [
      makeProject({ uuid: "ffffffff-0002-0000-0000-000000000001", name: "page2-proj" }),
    ];

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(makeProjectsBody(page1), { status: 200 });
      }
      return new Response(makeProjectsBody(page2), { status: 200 });
    }) as typeof fetch;

    const sync = makeDTSyncable();
    const r = await sync.sync(syncTestContext(db, makeStubVault(), "dependencytrack"), null);
    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(101);
    expectServiceItemCount(db, "dependencytrack", 101);
    expect(r.cursor).toContain("nimbus-dependencytrack1:");
  });
});
