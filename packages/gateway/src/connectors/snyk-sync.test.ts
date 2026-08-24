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
import { createSnykSyncable } from "./snyk-sync.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a /v1/orgs JSON response */
function makeOrgsResponse(orgs: unknown[]): string {
  return JSON.stringify({ orgs });
}

/** Build a /v1/org/:id/projects JSON response */
function makeProjectsResponse(projects: unknown[]): string {
  return JSON.stringify({ projects });
}

/** Build a /v1/org/:id/project/:id/aggregated-issues JSON response */
function makeIssuesResponse(issues: unknown[]): string {
  return JSON.stringify({ issues });
}

/** A minimal valid aggregated-issue object that will map to a row */
function makeIssue(id: string, title?: string): Record<string, unknown> {
  return {
    id,
    issueData: {
      title: title ?? `Issue ${id}`,
      description: `Description for ${id}`,
      url: `https://snyk.io/vuln/${id}`,
      severity: "high",
    },
    pkgName: "some-pkg",
    pkgVersions: ["1.0.0"],
    issueType: "vuln",
    fixInfo: { isFixable: true, fixedIn: ["1.0.1"] },
  };
}

function makeFactory() {
  return createSnykSyncable({ ensureSnykMcpRunning: async () => {} });
}

// ---------------------------------------------------------------------------
// No-op when token missing
// ---------------------------------------------------------------------------

testConnectorSyncNoop(
  "no-op when token is missing",
  makeFactory,
  createStubVault({ "snyk.token": null }),
);

testConnectorSyncNoop(
  "no-op when token is empty string",
  makeFactory,
  createStubVault({ "snyk.token": "  " }),
);

// ---------------------------------------------------------------------------
// Main suite (fetch-intercepted)
// ---------------------------------------------------------------------------

describeWithFetchRestore("snyk-sync", () => {
  // ── orgs HTTP error ────────────────────────────────────────────────────────
  test("returns http_error cursor advance when /v1/orgs returns non-2xx", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }))) as unknown as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // http_error → syncPassCursorHttpEmpty → itemsUpserted 0, cursor advances
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── orgs parse error ───────────────────────────────────────────────────────
  test("returns parse_error cursor advance when /v1/orgs body is not JSON", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // parse_error → syncPassCursorParseEmpty → itemsUpserted 0
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── extractOrgIds: orgs field is not an array → return [] (line 62) ────────
  test("returns 0 items when orgs field in response is not an array", async () => {
    const db = createMemoryIndexDb();
    // orgs is an object, not an array → !Array.isArray(orgs) → return []
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ orgs: { not: "array" } }), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── extractOrgIds: asRecord(parsed) returns undefined (line 59 ?? branch) ──
  test("handles orgs response whose root is not an object (null parsed)", async () => {
    const db = createMemoryIndexDb();
    // JSON null → asRecord returns undefined → ?? {} → orgs undefined → not array → []
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(null), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ── extractOrgIds: org entry is non-object → continue (line 67,68) ─────────
  test("skips non-object entries in orgs array (line 67-68 continue)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      callCount++;
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        // One valid org, one primitive (non-object) that will be skipped
        return new Response(makeOrgsResponse(["not-an-object", { id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([]), { status: 200 });
      }
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // "not-an-object" skipped; org-1 processed (no projects → 0 items)
    expect(r.itemsUpserted).toBe(0);
    // /v1/orgs call + /projects for org-1 = 2 calls
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  // ── extractOrgIds: org has empty-string id → skipped (line 71 branch) ──────
  test("skips org entries with empty-string id", async () => {
    const db = createMemoryIndexDb();
    let projectCallMade = false;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        // One org with empty id (skipped), one with undefined id (stringField → undefined → skipped)
        return new Response(makeOrgsResponse([{ id: "" }, { no_id_field: true }]), { status: 200 });
      }
      projectCallMade = true;
      return new Response(makeProjectsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    // No org ids extracted → no project calls
    expect(projectCallMade).toBe(false);
  });

  // ── extractProjectIds: projects field not an array (line 81,82) ──────────────
  test("returns 0 items when projects field is not an array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      // projects is a string → not an array → return []
      return new Response(JSON.stringify({ projects: "not-an-array" }), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
  });

  // ── extractProjectIds: project entry is non-object (line 87,88 continue) ────
  test("skips non-object entries in projects array (line 87-88 continue)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        // Mix: primitive (skipped) and valid project
        return new Response(makeProjectsResponse([42, { id: "proj-1" }]), { status: 200 });
      }
      // aggregated-issues call
      return new Response(makeIssuesResponse([makeIssue("SNYK-001")]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // primitive skipped, proj-1 processed → 1 issue
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "snyk", 1);
  });

  // ── extractProjectIds: project entry has empty id (line 91 branch) ──────────
  test("skips project entries with empty-string id", async () => {
    const db = createMemoryIndexDb();
    let issueCallMade = false;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        // empty-string id → skipped; undefined id field → skipped
        return new Response(makeProjectsResponse([{ id: "" }, { no_id: true }]), { status: 200 });
      }
      issueCallMade = true;
      return new Response(makeIssuesResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(issueCallMade).toBe(false);
  });

  // ── ingestProjectIssues: issues endpoint returns http_error (line 119,120) ──
  test("handles http_error from aggregated-issues endpoint (line 119-120)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      // aggregated-issues returns 403
      return new Response("Forbidden", { status: 403 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // http_error on issues → upserted 0 for that project → total 0
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── ingestProjectIssues: issues endpoint returns parse_error (line 119,120) ─
  test("handles parse_error from aggregated-issues endpoint (line 119 parse_error branch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      // invalid JSON body with 200
      return new Response("{{bad json}}", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
  });

  // ── ingestOrgProjects: projects endpoint returns http_error (line 145,146) ──
  test("handles http_error from /projects endpoint (line 145-146)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      // projects endpoint returns 500
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // http_error on projects → upserted 0
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── ingestOrgProjects: projects endpoint returns parse_error (line 145) ──────
  test("handles parse_error from /projects endpoint (line 145 parse_error branch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      // projects endpoint returns 200 but invalid JSON
      return new Response("not-json-at-all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
  });

  // ── extractIssues: issues field is not an array (line 101 else branch) ───────
  test("returns empty issues list when issues field is not an array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      // issues field is a string (not array) → extractIssues returns []
      return new Response(JSON.stringify({ issues: "not-an-array" }), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ── extractIssues: root is not an object (line 99 ?? branch) ─────────────────
  test("handles aggregated-issues response where root is null", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      // root is JSON null → asRecord returns undefined → ?? {} → issues undefined → []
      return new Response(JSON.stringify(null), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  // ── Happy path: one org, one project, one issue ───────────────────────────────
  test("happy path: indexes one issue from one org/project", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      return new Response(makeIssuesResponse([makeIssue("SNYK-001")]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "snyk", 1);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── Happy path: multiple orgs + multiple projects ─────────────────────────────
  test("happy path: sums issues across multiple orgs and projects", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }, { id: "org-2" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        // Both orgs get two projects each
        return new Response(makeProjectsResponse([{ id: "proj-a" }, { id: "proj-b" }]), {
          status: 200,
        });
      }
      // Each project gets one unique issue — use URL to derive a unique id
      const parts = u.split("/");
      const projectId = parts[parts.indexOf("project") + 1] ?? "x";
      return new Response(makeIssuesResponse([makeIssue(`vuln-${projectId}`)]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // 2 orgs × 2 projects × 1 issue = 4
    expect(r.itemsUpserted).toBe(4);
    expectServiceItemCount(db, "snyk", 4);
  });

  // ── mapSnykAggregatedIssueToItem returns null → issue skipped ────────────────
  test("skips issues where mapSnykAggregatedIssueToItem returns null (no id field)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/v1/orgs")) {
        return new Response(makeOrgsResponse([{ id: "org-1" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj-1" }]), { status: 200 });
      }
      // Issue with no 'id' → mapSnykAggregatedIssueToItem returns null → skipped
      // Also include one primitive entry to cover the non-record path
      return new Response(
        makeIssuesResponse([{ no_id: true }, "primitive", makeIssue("SNYK-VALID")]),
        { status: 200 },
      );
    }) as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    // Only SNYK-VALID mapped; no_id and primitive both return null → skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "snyk", 1);
  });

  // ── Empty orgs array ──────────────────────────────────────────────────────────
  test("returns 0 items when orgs array is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeOrgsResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = makeFactory();
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snyk", 0);
    expect(r.cursor).toContain("nimbus-snyk1:");
  });

  // ── ensureSnykMcpRunning is called ───────────────────────────────────────────
  test("calls ensureSnykMcpRunning before syncing", async () => {
    const db = createMemoryIndexDb();
    let mcpCalled = false;

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeOrgsResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createSnykSyncable({
      ensureSnykMcpRunning: async () => {
        mcpCalled = true;
      },
    });
    await sync.sync(syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"), null);
    expect(mcpCalled).toBe(true);
  });

  // ── Verifies fetch URL shape (org + project path encoding) ───────────────────
  test("uses correct URL for org and project IDs (URL-encodes them)", async () => {
    const db = createMemoryIndexDb();
    const capturedUrls: string[] = [];

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      capturedUrls.push(u);
      if (u.includes("/v1/orgs")) {
        // IDs with reserved characters so the encoding is actually observable.
        return new Response(makeOrgsResponse([{ id: "org a/b" }]), { status: 200 });
      }
      if (u.includes("/projects") && !u.includes("aggregated-issues")) {
        return new Response(makeProjectsResponse([{ id: "proj?xyz" }]), { status: 200 });
      }
      return new Response(makeIssuesResponse([makeIssue("SNYK-001")]), { status: 200 });
    }) as typeof fetch;

    const sync = makeFactory();
    await sync.sync(syncTestContext(db, createStubVault({ "snyk.token": "tok" }), "snyk"), null);

    // encodeURIComponent("org a/b") === "org%20a%2Fb"; encodeURIComponent("proj?xyz") === "proj%3Fxyz"
    expect(capturedUrls.some((u) => u.includes("/v1/org/org%20a%2Fb/projects"))).toBe(true);
    expect(
      capturedUrls.some((u) =>
        u.includes("/v1/org/org%20a%2Fb/project/proj%3Fxyz/aggregated-issues"),
      ),
    ).toBe(true);
  });
});
