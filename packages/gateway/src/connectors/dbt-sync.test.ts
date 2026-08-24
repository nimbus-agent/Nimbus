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
import { createDbtSyncable } from "./dbt-sync.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal valid dbt Job object accepted by mapDbtJobToItem */
function makeJob(id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    project_id: 99,
    environment_id: 10,
    dbt_version: "1.6.0",
    state: 1,
    schedule: { cron: "0 * * * *" },
    triggers: { github_webhook: true },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-04-01T12:00:00.000Z",
    most_recent_run: { status_humanized: "Success", finished_at: "2026-04-01T12:30:00.000Z" },
  };
}

/** Wrap an array of jobs in a dbt Cloud API shape: { data: [...] } */
function makeJobsResponse(jobs: unknown[]): string {
  return JSON.stringify({ data: jobs });
}

/** Wrap an array of accounts in a dbt Cloud API shape */
function makeAccountsResponse(accounts: unknown[]): string {
  return JSON.stringify({ data: accounts });
}

function makeAccount(id: number): Record<string, unknown> {
  return { id };
}

/** Factory shorthand — MCP hook is a no-op for all tests */
function syncable() {
  return createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describeWithFetchRestore("dbt-sync", () => {
  // ── No-op: token missing ──────────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when token is missing",
    syncable,
    createStubVault({ "dbt.token": null }),
  );

  // ── No-op: token is empty string (trim → "") ──────────────────────────────
  testConnectorSyncNoop(
    "no-op when token trims to empty string",
    syncable,
    createStubVault({ "dbt.token": "   " }),
  );

  // ── Happy path: account_id configured (bypasses /accounts/ fetch) ─────────
  // Covers: loadCreds success, resolveAccounts creds.accountId !== null branch,
  // syncAccountJobs, upsertJobs, syncPassCursorSuccess.
  // Also covers trimTrailingSlash false branch (apiBase has no trailing slash).
  test("indexes jobs when account_id is configured (no /accounts/ fetch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      // Only jobs endpoint should be called
      expect(u).toContain("/api/v2/accounts/42/jobs/");
      return new Response(makeJobsResponse([makeJob(1001, "My Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "42",
          "dbt.api_base": null,
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-dbt1:");
    expectServiceItemCount(db, "dbt", 1);
  });

  // ── Happy path: api_base with trailing slash (trimTrailingSlash true branch) ──
  // Covers line 37 true branch and line 50 baseRaw !== "" branch.
  test("trims trailing slash from custom api_base", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      // Must NOT have double slash before /api/v2
      expect(u).not.toContain("//api/v2");
      expect(u).toContain("https://custom.dbt.example/api/v2/accounts/7/jobs/");
      return new Response(makeJobsResponse([makeJob(2001, "Trimmed Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "7",
          "dbt.api_base": "https://custom.dbt.example/", // trailing slash
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── Happy path: api_base without trailing slash (trimTrailingSlash false branch) ──
  test("accepts api_base without trailing slash unchanged", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("https://nodeslash.dbt.example/api/v2/accounts/8/jobs/");
      return new Response(makeJobsResponse([makeJob(3001, "No Slash Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "8",
          "dbt.api_base": "https://nodeslash.dbt.example", // no trailing slash
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── Happy path: no account_id → fetches /accounts/ first ─────────────────
  // Covers: resolveAccounts with accountId null, extractAccountIds, extractData { data: [...] }.
  // Also covers line 63 (Array.isArray(data) = true) and line 50 (baseRaw === "").
  test("fetches accounts list when account_id is absent, then jobs", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      callCount += 1;
      if (callCount === 1) {
        expect(u).toContain("/api/v2/accounts/");
        return new Response(makeAccountsResponse([makeAccount(100), makeAccount(200)]), {
          status: 200,
        });
      }
      // Subsequent calls are jobs requests for each account
      return new Response(makeJobsResponse([makeJob(5001, `Job for ${u}`)]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
          "dbt.api_base": null,
        }),
        "dbt",
      ),
      null,
    );

    // 2 accounts × 1 job each = 2 jobs
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "dbt", 2);
  });

  // ── extractData: parsed is a plain array (line 66 Array.isArray(parsed) true) ──
  // Covers the branch where the API returns a bare JSON array instead of {data:[...]}.
  test("handles bare array response for accounts list", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      callCount += 1;
      if (callCount === 1) {
        // Bare array of accounts — extractData will take the Array.isArray(parsed) branch
        return new Response(JSON.stringify([makeAccount(55)]), { status: 200 });
      }
      expect(u).toContain("/api/v2/accounts/55/jobs/");
      return new Response(makeJobsResponse([makeJob(9001, "Bare Array Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
          "dbt.api_base": null,
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dbt", 1);
  });

  // ── extractData: parsed has no usable array → returns [] (line 66 false branch) ──
  // A scalar value that is neither an array nor has a "data" array field.
  test("handles non-array non-record accounts response (zero accounts extracted)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      // Returns a JSON string — extractData: asRecord("nope") = undefined, Array.isArray = false → []
      return new Response(JSON.stringify("nope"), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    // No accounts → no jobs → 0 upserted but cursor advances
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dbt1:");
  });

  // ── extractAccountIds: non-record element → continue (line 73) ───────────
  // Covers the `asRecord(a) === undefined → continue` branch.
  test("skips non-object elements in accounts array when extracting account ids", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        // Mix: string (skipped by asRecord), valid account
        return new Response(JSON.stringify({ data: ["not-an-object", makeAccount(77)] }), {
          status: 200,
        });
      }
      return new Response(makeJobsResponse([makeJob(6001, "Skipped Primitive Job")]), {
        status: 200,
      });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractAccountIds: record without numeric "id" → skipped (line 77) ────
  // Covers the `numberField(row, "id") === undefined` branch.
  test("skips account records missing numeric id", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        // Object with non-numeric id (string) → numberField returns undefined
        return new Response(JSON.stringify({ data: [{ id: "not-a-number" }, makeAccount(88)] }), {
          status: 200,
        });
      }
      return new Response(makeJobsResponse([makeJob(7001, "ID Missing Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    // Only account 88 extracted, 1 job
    expect(r.itemsUpserted).toBe(1);
  });

  // ── upsertJobs: mapped === null → continue (line 102) ────────────────────
  // mapDbtJobToItem returns null when the raw item has no numeric "id".
  test("skips job items that fail mapping (no numeric id)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      return new Response(
        makeJobsResponse([
          { name: "No ID Job" }, // missing numeric id → mapDbtJobToItem returns null
          makeJob(4001, "Valid Job"),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "42",
        }),
        "dbt",
      ),
      null,
    );

    // Only the valid job is upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dbt", 1);
  });

  // ── upsertJobs: non-record job item → mapped null (asRecord branch) ───────
  test("skips non-object job entries in data array", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      return new Response(makeJobsResponse(["not-an-object", makeJob(4002, "After Primitive")]), {
        status: 200,
      });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "42",
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dbt", 1);
  });

  // ── resolveAccounts: http_error → syncPassCursorHttpEmpty (lines 170-171) ──
  // Covers: "error" in resolved, resolved.error === "http_error" true branch.
  test("returns http-empty cursor when /accounts/ fetch returns HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    // http_error → syncPassCursorHttpEmpty → cursor advances, 0 upserted
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dbt1:");
    expectServiceItemCount(db, "dbt", 0);
  });

  // ── resolveAccounts: parse_error → syncPassCursorParseEmpty (line 171) ────
  // Covers: "error" in resolved, resolved.error === "http_error" false branch.
  test("returns parse-empty cursor when /accounts/ response is invalid JSON", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      return new Response("not-json-at-all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    // parse_error → syncPassCursorParseEmpty → cursor advances, 0 upserted
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dbt1:");
    expectServiceItemCount(db, "dbt", 0);
  });

  // ── Jobs fetch HTTP error → warns and breaks the page loop ───────────────
  // Covers: outcome.kind !== "ok" break inside syncAccountJobs.
  test("breaks jobs page loop on HTTP error, returns partial upserts", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        // accounts
        return new Response(makeAccountsResponse([makeAccount(10)]), { status: 200 });
      }
      // jobs HTTP error
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dbt1:");
  });

  // ── Pagination: full page → fetches next page, partial page → stops ───────
  // Covers: jobs.length < PAGE_SIZE break (false on first page, true on second).
  test("paginates jobs until a partial page is returned", async () => {
    const db = createMemoryIndexDb();
    const PAGE_SIZE = 100;
    let callCount = 0;

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      callCount += 1;
      if (callCount === 1) {
        // accounts
        return new Response(makeAccountsResponse([makeAccount(20)]), { status: 200 });
      }
      // Detect page by offset parameter
      const url = new URL(u);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) {
        // Full page — return exactly PAGE_SIZE jobs
        const jobs = Array.from({ length: PAGE_SIZE }, (_, i) => makeJob(i + 1, `Job ${i + 1}`));
        return new Response(makeJobsResponse(jobs), { status: 200 });
      }
      // Partial page — return fewer than PAGE_SIZE jobs → loop breaks
      return new Response(makeJobsResponse([makeJob(999, "Last Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    // 100 (full page) + 1 (partial page) = 101
    expect(r.itemsUpserted).toBe(101);
    expectServiceItemCount(db, "dbt", 101);
  });

  // ── account_id: invalid (non-numeric) string → null accountId ────────────
  // Covers: Number.parseInt result NaN → Number.isFinite false → accountId: null.
  test("treats non-numeric account_id as absent (fetches /accounts/)", async () => {
    const db = createMemoryIndexDb();
    let accountsCallMade = false;

    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/accounts/") && !u.includes("/jobs/")) {
        accountsCallMade = true;
        return new Response(makeAccountsResponse([makeAccount(33)]), { status: 200 });
      }
      return new Response(makeJobsResponse([makeJob(8001, "Fallback Job")]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "not-a-number",
        }),
        "dbt",
      ),
      null,
    );

    expect(accountsCallMade).toBe(true);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── Empty jobs response → 0 upserted, cursor advances ────────────────────
  test("returns 0 upserted when jobs data array is empty", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      return new Response(makeJobsResponse([]), { status: 200 });
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": "42",
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dbt1:");
    expectServiceItemCount(db, "dbt", 0);
  });

  // ── Multiple accounts: jobs aggregated ────────────────────────────────────
  test("aggregates upserted counts across multiple accounts", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          makeAccountsResponse([makeAccount(11), makeAccount(22), makeAccount(33)]),
          { status: 200 },
        );
      }
      // Each account gets 2 jobs
      const accOffset = callCount - 2;
      return new Response(
        makeJobsResponse([
          makeJob(accOffset * 100 + 1, `Acc Job A`),
          makeJob(accOffset * 100 + 2, `Acc Job B`),
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const r = await syncable().sync(
      syncTestContext(
        db,
        createStubVault({
          "dbt.token": "tok",
          "dbt.account_id": null,
        }),
        "dbt",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(6);
    expectServiceItemCount(db, "dbt", 6);
  });
});
