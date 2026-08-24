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
import { createFlagsmithSyncable } from "./flagsmith-sync.ts";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeProjectsResponse(projects: unknown[]): string {
  return JSON.stringify(projects);
}

function makeTagsResponse(tags: unknown[]): string {
  return JSON.stringify(tags);
}

/** Build a features page response with an optional "next" cursor */
function makeFeaturesPage(features: unknown[], hasNext: boolean): string {
  return JSON.stringify({
    results: features,
    next: hasNext ? "https://api.flagsmith.com/api/v1/next-page" : null,
    previous: null,
    count: features.length,
  });
}

/** Minimal valid project */
function proj(id: number, name = `Project ${id}`): Record<string, unknown> {
  return { id, name };
}

/** Minimal valid feature (mapFlagsmithFeatureToItem requires "name") */
function feat(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, type: "STANDARD", default_enabled: false, ...extra };
}

const STUB_VAULT_WITH_TOKEN = createStubVault({ "flagsmith.token": "test-tok" });
const STUB_VAULT_NO_TOKEN = createStubVault({ "flagsmith.token": null });

// ---------------------------------------------------------------------------
// Helper to create syncable (ensureFlagsmithMcpRunning is always a no-op)
// ---------------------------------------------------------------------------
function makeSyncable() {
  return createFlagsmithSyncable({ ensureFlagsmithMcpRunning: async () => {} });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithFetchRestore("flagsmith-sync", () => {
  // ─── no-op when token is missing (lines 37-39, branch 43) ─────────────────
  testConnectorSyncNoop("no-op when token missing", makeSyncable, STUB_VAULT_NO_TOKEN);

  // ─── custom api_base is used (branch 43 true: baseRaw !== "") ─────────────
  test("uses custom api_base when provided", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/projects/")) {
        // Return empty project list so sync completes cleanly
        return new Response(makeProjectsResponse([]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "flagsmith.token": "tok",
          "flagsmith.api_base": "https://my-flagsmith.example.com",
        }),
        "flagsmith",
      ),
      null,
    );
    // No projects → 0 upserted, cursor advances
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
  });

  // ─── default api_base when api_base is empty/missing (branch 43 false) ────
  test("uses default api_base when api_base vault entry is empty", async () => {
    const db = createMemoryIndexDb();
    let seenUrl = "";

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      seenUrl = urlFromFetchInput(input);
      return new Response(makeProjectsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({ "flagsmith.token": "tok", "flagsmith.api_base": "" }),
        "flagsmith",
      ),
      null,
    );
    expect(seenUrl).toContain("api.flagsmith.com");
  });

  // ─── happy path: projects + features upserted, cursor set (lines 57–63, 76,
  //     80, 92, 141, 158, 205) ──────────────────────────────────────────────
  test("indexes features from projects and advances cursor", async () => {
    const db = createMemoryIndexDb();
    const projectList = [proj(1, "Alpha"), proj(2, "Beta")];

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(makeProjectsResponse(projectList), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([{ id: 10, label: "core" }]), { status: 200 });
      }
      // features
      return new Response(makeFeaturesPage([feat("dark-mode"), feat("beta-nav")], false), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);

    // 2 projects × 2 features each = 4 upserted
    expect(r.itemsUpserted).toBe(4);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
    expectServiceItemCount(db, "flagsmith", 4);
  });

  // ─── extractArray: bare array (line 54 branch: Array.isArray(parsed) true) ─
  test("extractArray handles bare array from projects response", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Bare array — extractArray short-circuits at Array.isArray
        return new Response(JSON.stringify([proj(5, "BareArray")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response(makeFeaturesPage([feat("flag-a")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractArray: results[] branch (line 59 branch true) ─────────────────
  test("extractArray uses results[] when present and not an array at top", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Object with "results" key — extractArray returns root["results"]
        return new Response(JSON.stringify({ results: [proj(6, "ResultsKey")], count: 1 }), {
          status: 200,
        });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response(makeFeaturesPage([feat("flag-b")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractArray: items[] branch (line 62-63: results not array, items array) ─
  test("extractArray falls back to items[] when results is absent", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Object with "items" key, no "results" key
        return new Response(JSON.stringify({ items: [proj(7, "ItemsKey")] }), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response(makeFeaturesPage([feat("flag-c")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractArray: neither results nor items → empty (branch 63 false) ────
  test("extractArray returns [] when neither results nor items present", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Object with unrecognised key — extractArray returns []
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      // Should not be reached for tags/features when projects returns empty
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    // No projects extracted → 0 upserted, cursor still set
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
  });

  // ─── extractProjects: skips non-object rows (line 75 branch true) ─────────
  test("extractProjects skips non-object entries in projects array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Mix: primitive (skipped), valid project
        return new Response(JSON.stringify(["not-an-object", proj(8, "ValidProj")]), {
          status: 200,
        });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response(makeFeaturesPage([feat("skip-test")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    // Only the valid project's 1 feature is indexed
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractProjects: skips rows missing id (line 79-80 branch true) ──────
  test("extractProjects skips project rows that lack an id field", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        // Row with no numeric id → skipped; valid row follows
        return new Response(JSON.stringify([{ name: "NoId" }, proj(9, "HasId")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response(makeFeaturesPage([feat("id-test")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractTagMap: non-object tag row skipped (line 91 branch true) ──────
  test("extractTagMap skips non-object tag entries", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(11, "TagSkip")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        // Primitive entries + valid tag
        return new Response(JSON.stringify(["bad-entry", { id: 20, label: "valid-tag" }]), {
          status: 200,
        });
      }
      return new Response(makeFeaturesPage([feat("tagged", { tags: [20] })], false), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractTagMap: id or label missing/empty → not added (line 96 branch) ─
  test("extractTagMap skips tag rows missing id or label", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(12, "BadTags")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(
          JSON.stringify([
            { label: "no-id" }, // missing id → skipped
            { id: 30 }, // missing label → skipped
            { id: 31, label: "" }, // empty label → skipped
            { id: 32, label: "good" }, // valid
          ]),
          { status: 200 },
        );
      }
      return new Response(makeFeaturesPage([feat("flag-tags")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── resolveProjects http_error → syncPassCursorHttpEmpty (line 158, 204–205)
  test("resolveProjects http_error returns cursor pass-through with existing cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const prevCursor = "prev-cursor-value";
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), prevCursor);

    // http_error → syncPassCursorHttpEmpty → cursor = incomingCursor ?? defaultCursor
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toBe(prevCursor);
    expectServiceItemCount(db, "flagsmith", 0);
  });

  // ─── resolveProjects http_error with null cursor → default cursor ──────────
  test("resolveProjects http_error with null cursor produces nimbus cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
  });

  // ─── resolveProjects parse_error → syncPassCursorParseEmpty (line 205 false branch)
  test("resolveProjects parse_error returns nimbus cursor regardless of incoming cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-valid-json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"),
      "any-old-cursor",
    );

    // parse_error → syncPassCursorParseEmpty → cursor = pass1Cursor()
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
  });

  // ─── tags fetch http_error → empty tagMap (line 172 branch: kind !== "ok") ─
  test("tags http_error yields empty tagMap and features still upserted", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(13, "TagFail")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response("Forbidden", { status: 403 });
      }
      // features — 1 feature with a tag id that won't resolve (tagMap is empty)
      return new Response(makeFeaturesPage([feat("no-tag-resolve", { tags: [99] })], false), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    // Feature still gets upserted even though tags failed
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── features pagination: hasNext=true stops when features.length < PAGE_SIZE
  //     (line 182: !hasNext || features.length < PAGE_SIZE) ──────────────────
  test("feature pagination stops early when page has fewer items than PAGE_SIZE", async () => {
    const db = createMemoryIndexDb();
    let pagesFetched = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(14, "PaginateStop")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      // features endpoint — first call returns < PAGE_SIZE items but hasNext=true
      pagesFetched++;
      // PAGE_SIZE = 100; return only 3 items with hasNext=true → should stop
      const smallPage = [feat("f1"), feat("f2"), feat("f3")];
      return new Response(makeFeaturesPage(smallPage, true), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    // Only 1 page fetched because features.length (3) < PAGE_SIZE (100)
    expect(pagesFetched).toBe(1);
    expect(r.itemsUpserted).toBe(3);
  });

  // ─── features pagination: hasNext=false stops (line 182 !hasNext branch) ──
  test("feature pagination stops when hasNext is false", async () => {
    const db = createMemoryIndexDb();
    let pagesFetched = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(15, "PaginateEnd")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      pagesFetched++;
      return new Response(makeFeaturesPage([feat("only-one")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(pagesFetched).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── features http_error mid-pagination breaks loop (line 177-179) ─────────
  test("feature fetch http_error breaks pagination loop", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(16, "FeatErr")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-flagsmith1:");
  });

  // ─── mapped feature null → skipped (line 140-141: mapped === null) ─────────
  test("features that map to null are skipped (name missing)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(17, "MapNull")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      // One feature with no "name" field → mapFlagsmithFeatureToItem returns null
      // One valid feature
      return new Response(makeFeaturesPage([{ type: "STANDARD" }, feat("valid-name")], false), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    // The nameless feature is skipped; only 1 upserted
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractFeaturesPage: results absent (line 116-118 branches) ──────────
  test("extractFeaturesPage: no results key yields empty features array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(18, "NoResults")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      // Response has no "results" key → features = []
      return new Response(JSON.stringify({ count: 0, next: null }), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── two projects accumulate bytes and upserted counts ────────────────────
  test("multiple projects accumulate itemsUpserted correctly", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.endsWith("/projects/")) {
        return new Response(JSON.stringify([proj(20, "P20"), proj(21, "P21")]), { status: 200 });
      }
      if (u.includes("/tags/")) {
        return new Response(makeTagsResponse([]), { status: 200 });
      }
      if (u.includes("/projects/20/")) {
        return new Response(makeFeaturesPage([feat("feat20a"), feat("feat20b")], false), {
          status: 200,
        });
      }
      // project 21
      return new Response(makeFeaturesPage([feat("feat21a")], false), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, STUB_VAULT_WITH_TOKEN, "flagsmith"), null);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "flagsmith", 3);
  });
});
