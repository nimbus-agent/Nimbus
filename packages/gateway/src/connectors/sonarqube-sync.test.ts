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
import { createSonarqubeSyncable } from "./sonarqube-sync.ts";

// ──────────────────────────────────────────────────────────
// Response-builder helpers
// ──────────────────────────────────────────────────────────

function makeComponentsResponse(keys: string[]): string {
  return JSON.stringify({
    components: keys.map((k) => ({ key: k, name: k })),
  });
}

function makeIssuesResponse(issues: unknown[], total?: number): string {
  return JSON.stringify({
    issues,
    paging: { total: total ?? issues.length, pageIndex: 1, pageSize: 100 },
  });
}

/** Minimal valid SonarQube issue fixture */
const FULL_ISSUE = {
  key: "AXZ-001",
  message: "Null pointer dereference",
  rule: "java:S2259",
  component: "my-project:src/main/Main.java",
  project: "my-project",
  severity: "CRITICAL",
  type: "BUG",
  status: "OPEN",
  creationDate: "2026-04-01T10:00:00+0000",
  updateDate: "2026-04-02T12:00:00+0000",
  tags: ["null-pointer"],
  effort: "5min",
  debt: "5min",
  author: "dev@example.com",
  line: 42,
};

// ──────────────────────────────────────────────────────────
// Factory shorthand
// ──────────────────────────────────────────────────────────

function makeSyncable() {
  return createSonarqubeSyncable({ ensureSonarqubeMcpRunning: async () => {} });
}

// ──────────────────────────────────────────────────────────
// Vault key references
// ──────────────────────────────────────────────────────────

const VAULT_WITH_TOKEN = createStubVault({
  "sonarqube.token": "sqp_test_token",
  "sonarqube.url": null,
  "sonarqube.organization": null,
});

const VAULT_WITH_ORG = createStubVault({
  "sonarqube.token": "sqp_test_token",
  "sonarqube.url": "https://sonarcloud.io",
  "sonarqube.organization": "my-org",
});

// ──────────────────────────────────────────────────────────
// No-op: token missing (line 89 branch: token === "")
// ──────────────────────────────────────────────────────────

testConnectorSyncNoop(
  "no-op when token is missing",
  makeSyncable,
  createStubVault({
    "sonarqube.token": null,
    "sonarqube.url": null,
    "sonarqube.organization": null,
  }),
);

// ──────────────────────────────────────────────────────────
// No-op: token is empty string (line 89 true branch)
// ──────────────────────────────────────────────────────────

testConnectorSyncNoop(
  "no-op when token is empty string",
  makeSyncable,
  createStubVault({
    "sonarqube.token": "  ",
    "sonarqube.url": null,
    "sonarqube.organization": null,
  }),
);

// ──────────────────────────────────────────────────────────
// All remaining tests use describeWithFetchRestore
// ──────────────────────────────────────────────────────────

describeWithFetchRestore("sonarqube-sync", () => {
  // ─── happy path: single project, single issue ────────────────────────────
  test("indexes a valid issue and advances cursor", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      callCount += 1;
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["my-project"]), { status: 200 });
      }
      expect(u).toContain("/api/issues/search");
      return new Response(makeIssuesResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
    expectServiceItemCount(db, "sonarqube", 1);
  });

  // ─── base-url defaults to sonarcloud.io when url is null ─────────────────
  test("uses DEFAULT_API when vault url is null", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      if (capturedUrl.includes("/api/components/search")) {
        return new Response(makeComponentsResponse([]), { status: 200 });
      }
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "sonarqube.token": "tok",
          "sonarqube.url": null,
          "sonarqube.organization": null,
        }),
      ),
      null,
    );

    expect(capturedUrl).toContain("sonarcloud.io");
  });

  // ─── url strips trailing slashes ─────────────────────────────────────────
  test("strips trailing slashes from base url", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      if (capturedUrl.includes("/api/components/search")) {
        return new Response(makeComponentsResponse([]), { status: 200 });
      }
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "sonarqube.token": "tok",
          "sonarqube.url": "https://sonar.example.com///",
          "sonarqube.organization": null,
        }),
      ),
      null,
    );

    expect(capturedUrl).toContain("sonar.example.com");
    // The triple trailing slashes from the vault value must have been stripped;
    // the URL must not contain "sonar.example.com///" (only the path separator slash is present).
    expect(capturedUrl).not.toContain("sonar.example.com///");
  });

  // ─── organization query param is included when org is set (line 159) ─────
  test("includes organization param in components query when org is set", async () => {
    const db = createMemoryIndexDb();
    let componentsUrl = "";

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        componentsUrl = u;
        return new Response(makeComponentsResponse([]), { status: 200 });
      }
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(syncTestContext(db, VAULT_WITH_ORG), null);

    expect(componentsUrl).toContain("organization=my-org");
  });

  // ─── projects endpoint http_error → syncPassCursorHttpEmpty (lines 187,188) ─
  test("returns http_error result when components fetch fails with non-ok status", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Forbidden", { status: 403 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
    expectServiceItemCount(db, "sonarqube", 0);
  });

  // ─── projects endpoint http_error preserves incoming cursor ───────────────
  test("returns incoming cursor when components fetch returns http_error and cursor is non-null", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Server Error", { status: 500 }))) as unknown as typeof fetch;

    const sync = makeSyncable();
    const incoming = "nimbus-sonarqube1:prev";
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), incoming);

    // syncPassCursorHttpEmpty: returns incomingCursor when non-null
    expect(r.cursor).toBe(incoming);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── projects endpoint parse_error → syncPassCursorParseEmpty (line 188) ──
  test("returns parse_error result when components response is not valid JSON", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
    expectServiceItemCount(db, "sonarqube", 0);
  });

  // ─── empty projects list → zero upserts ──────────────────────────────────
  test("zero upserts when projects list is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeComponentsResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
  });

  // ─── issues endpoint http_error (line 122: outcome.kind !== "ok" → break) ─
  test("breaks out of page loop when issues endpoint returns http_error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      // issues endpoint → 500
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
    expectServiceItemCount(db, "sonarqube", 0);
  });

  // ─── malformed issue (no key) → skipped (line 148 mapped === null) ────────
  test("skips issues missing required key field", async () => {
    const db = createMemoryIndexDb();
    const badIssue = { message: "No key here", severity: "MAJOR" }; // no key

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      return new Response(makeIssuesResponse([badIssue, FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    // Only the valid FULL_ISSUE is upserted; badIssue is skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "sonarqube", 1);
  });

  // ─── non-object in issues array → skipped (mapped === null) ───────────────
  test("skips non-object entries in issues array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      // Mix: non-object primitive (null) and valid issue
      const body = JSON.stringify({
        issues: [null, "string-not-object", FULL_ISSUE],
        paging: { total: 3, pageIndex: 1, pageSize: 100 },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    // null and string are skipped; only FULL_ISSUE upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "sonarqube", 1);
  });

  // ─── extractProjectKeys: non-array components → empty (line 45 true) ──────
  test("returns zero projects when components field is not an array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        // components is an object, not array
        return new Response(JSON.stringify({ components: { notAnArray: true } }), { status: 200 });
      }
      return new Response(makeIssuesResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "sonarqube", 0);
  });

  // ─── extractProjectKeys: parsed is not a record → root = {} (line 43) ─────
  test("handles non-record components response (null parsed)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        // Valid JSON but top-level is an array (asRecord returns undefined → root = {})
        return new Response(JSON.stringify(["not", "a", "record"]), { status: 200 });
      }
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
  });

  // ─── extractProjectKeys: component entry is non-object → skipped (line 51) ─
  test("skips non-object entries in components array", async () => {
    const db = createMemoryIndexDb();
    let issueCallCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        // Mix: primitive (skipped) + valid object + object with empty key (skipped)
        return new Response(
          JSON.stringify({
            components: [
              "not-an-object",
              null,
              { key: "" }, // empty key — stringField returns "" → condition fails
              { key: "valid-proj" },
            ],
          }),
          { status: 200 },
        );
      }
      issueCallCount += 1;
      return new Response(makeIssuesResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    // Only "valid-proj" passes → 1 issues call
    expect(issueCallCount).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── extractIssues: issues not an array → [] (line 65 false branch) ──────
  test("handles response where issues field is not an array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      // issues is an object, not array
      return new Response(
        JSON.stringify({
          issues: { notAnArray: true },
          paging: { total: 0, pageIndex: 1, pageSize: 100 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "sonarqube", 0);
  });

  // ─── extractTotal: paging field is not a record → total = 0 (lines 69-72) ─
  test("extracts total=0 when paging field is not a record", async () => {
    const db = createMemoryIndexDb();

    // Build exactly 100 issues (PAGE_SIZE) so pagination check triggers
    const hundredIssues = Array.from({ length: 100 }, (_, i) => ({
      ...FULL_ISSUE,
      key: `AXZ-${String(i).padStart(3, "0")}`,
    }));

    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      callCount += 1;
      // paging is a primitive → asRecord returns undefined → total = 0
      // issues.length (100) is NOT < PAGE_SIZE (100), but page*PAGE_SIZE(100) >= total(0) → break
      return new Response(
        JSON.stringify({
          issues: hundredIssues,
          paging: "not-a-record",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    // Should stop after one page since total=0 and page*PAGE_SIZE(100) >= 0
    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(100);
  });

  // ─── extractTotal: total is not a number → 0 (line 72 false branch) ──────
  test("extracts total=0 when paging.total is not a number", async () => {
    const db = createMemoryIndexDb();

    const hundredIssues = Array.from({ length: 100 }, (_, i) => ({
      ...FULL_ISSUE,
      key: `BXZ-${String(i).padStart(3, "0")}`,
    }));

    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      callCount += 1;
      return new Response(
        JSON.stringify({
          issues: hundredIssues,
          paging: { total: "not-a-number", pageIndex: 1, pageSize: 100 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(100);
  });

  // ─── pagination: issues.length < PAGE_SIZE → break after first page ──────
  test("stops pagination when issues page is less than PAGE_SIZE", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      callCount += 1;
      // Fewer than 100 issues → break condition: issues.length < PAGE_SIZE
      return new Response(makeIssuesResponse([FULL_ISSUE], 500), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── pagination: multiple pages until total exhausted ────────────────────
  test("fetches multiple pages for a project until total is exhausted", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    // 2 pages: page1 = 100 issues, total = 150; page2 = 50 issues < PAGE_SIZE → break
    const page1Issues = Array.from({ length: 100 }, (_, i) => ({
      ...FULL_ISSUE,
      key: `P1-${String(i).padStart(3, "0")}`,
    }));
    const page2Issues = Array.from({ length: 50 }, (_, i) => ({
      ...FULL_ISSUE,
      key: `P2-${String(i).padStart(3, "0")}`,
    }));

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({ issues: page1Issues, paging: { total: 150 } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ issues: page2Issues, paging: { total: 150 } }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(callCount).toBe(2);
    expect(r.itemsUpserted).toBe(150);
    expectServiceItemCount(db, "sonarqube", 150);
  });

  // ─── pagination: page * PAGE_SIZE >= total → break (line 128 right branch) ─
  test("stops pagination when page * PAGE_SIZE reaches total", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    // 100 issues, total = 100 → page(1)*PAGE_SIZE(100) >= 100 → break after page 1
    const exactIssues = Array.from({ length: 100 }, (_, i) => ({
      ...FULL_ISSUE,
      key: `EX-${String(i).padStart(3, "0")}`,
    }));

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      callCount += 1;
      return new Response(JSON.stringify({ issues: exactIssues, paging: { total: 100 } }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(100);
  });

  // ─── multiple projects are each synced independently ──────────────────────
  test("syncs multiple projects accumulating upserted counts", async () => {
    const db = createMemoryIndexDb();

    const issueA = {
      ...FULL_ISSUE,
      key: "PROJ-A-001",
      component: "proj-a:File.java",
      project: "proj-a",
    };
    const issueB = {
      ...FULL_ISSUE,
      key: "PROJ-B-001",
      component: "proj-b:File.java",
      project: "proj-b",
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a", "proj-b"]), { status: 200 });
      }
      if (u.includes("componentKeys=proj-a%2Cproj-b")) {
        return new Response(makeIssuesResponse([issueA, issueB]), { status: 200 });
      }
      if (u.includes("componentKeys=proj-a")) {
        return new Response(makeIssuesResponse([issueA]), { status: 200 });
      }
      return new Response(makeIssuesResponse([issueB]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "sonarqube", 2);
  });

  // ─── issue with optional fields absent → syncedAt used as modifiedAt ──────
  test("uses syncedAt as modifiedAt when updateDate and creationDate are absent", async () => {
    const db = createMemoryIndexDb();
    const minimalIssue = {
      key: "MIN-001",
      message: "minimal",
      // no updateDate, no creationDate
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      return new Response(makeIssuesResponse([minimalIssue]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const before = Date.now();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);
    const after = Date.now();

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare(
        "SELECT modified_at FROM item WHERE service = 'sonarqube' AND external_id = 'MIN-001'",
      )
      .get() as { modified_at: number } | undefined;
    // modified_at is stamped at ingestion → it must fall within the [before, after] sync window
    // (a fixed "now - 5s" cutoff is flaky under slow CI).
    expect(row?.modified_at).toBeGreaterThanOrEqual(before);
    expect(row?.modified_at).toBeLessThanOrEqual(after);
    expectServiceItemCount(db, "sonarqube", 1);
  });

  // ─── url field reflects organization in canonicalUrl (line 159 branch) ────
  test("canonical url includes organization when org is set", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      return new Response(makeIssuesResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(syncTestContext(db, VAULT_WITH_ORG), null);

    const row = db
      .prepare("SELECT url FROM item WHERE service = 'sonarqube' AND external_id = 'AXZ-001'")
      .get() as { url: string | null } | undefined;
    expect(row?.url).toContain("my-org");
  });

  // ─── url field without organization ───────────────────────────────────────
  test("canonical url excludes organization when org is not set", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      return new Response(makeIssuesResponse([FULL_ISSUE]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    const row = db
      .prepare("SELECT url FROM item WHERE service = 'sonarqube' AND external_id = 'AXZ-001'")
      .get() as { url: string | null } | undefined;
    expect(row?.url).not.toContain("my-org");
  });

  // ─── issues endpoint parse_error → break with partial bytes (line 122) ────
  test("breaks from page loop when issues response is parse_error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      // parse_error: ok=true but invalid JSON
      return new Response("not-valid-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    // parse_error outcome.kind !== "ok" → break → upserted = 0
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-sonarqube1:");
  });

  // ─── extractIssues: parsed is null/array (asRecord ?? {}) → issues = [] ──
  test("returns zero upserts when issues response body is a JSON array (not record)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/api/components/search")) {
        return new Response(makeComponentsResponse(["proj-a"]), { status: 200 });
      }
      // Valid JSON but array → asRecord returns undefined → root = {} → issues = []
      return new Response(JSON.stringify(["not", "a", "record"]), { status: 200 });
    }) as typeof fetch;

    const sync = makeSyncable();
    const r = await sync.sync(syncTestContext(db, VAULT_WITH_TOKEN), null);

    expect(r.itemsUpserted).toBe(0);
  });

  // ─── existing cursor is returned as-is when sync is no-op ─────────────────
  test("preserves cursor on no-op (token missing) regardless of incoming cursor", async () => {
    const db = createMemoryIndexDb();
    const sync = makeSyncable();
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "sonarqube.token": null,
          "sonarqube.url": null,
          "sonarqube.organization": null,
        }),
      ),
      "some-previous-cursor",
    );
    // syncNoopResult returns incomingCursor as cursor
    expect(r.cursor).toBe("some-previous-cursor");
    expect(r.itemsUpserted).toBe(0);
  });
});
