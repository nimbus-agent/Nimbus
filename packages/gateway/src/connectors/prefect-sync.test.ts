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
import { createPrefectSyncable } from "./prefect-sync.ts";

/** Minimal valid deployment fixture. */
const FULL_DEPLOYMENT = {
  id: "dep-uuid-1",
  name: "daily-etl",
  flow_id: "flow-uuid-1",
  description: "Runs daily ETL",
  paused: false,
  work_pool_name: "default",
  work_queue_name: "default",
  status: "READY",
  created: "2026-04-01T10:00:00.000Z",
  updated: "2026-06-01T08:00:00.000Z",
  tags: ["prod", "etl"],
  schedules: [{ cron: "0 5 * * *" }],
};

/** Bare array of deployments as Prefect returns. */
function makeDeploymentPage(items: unknown[]): string {
  return JSON.stringify(items);
}

const NOOP_VAULT_MISSING_URL = createStubVault({
  "prefect.api_url": null,
  "prefect.api_key": "secret-key",
});

const NOOP_VAULT_MISSING_KEY = createStubVault({
  "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
  "prefect.api_key": null,
});

describeWithFetchRestore("prefect-sync", () => {
  // ─── No-op when primary credential missing ───────────────────────────────
  testConnectorSyncNoop(
    "no-op when api_url is missing",
    () => createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} }),
    NOOP_VAULT_MISSING_URL,
  );

  testConnectorSyncNoop(
    "no-op when api_key is missing",
    () => createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} }),
    NOOP_VAULT_MISSING_KEY,
  );

  // ─── Happy path: items upserted, cursor advances ─────────────────────────
  test("indexes deployments and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("/deployments/filter");
      return new Response(makeDeploymentPage([FULL_DEPLOYMENT]), { status: 200 });
    }) as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-prefect1:");
    expectServiceItemCount(db, "prefect", 1);
  });

  // ─── Line 34: api_url with trailing slash is trimmed ─────────────────────
  // Covers the true-branch of trimTrailingSlash (s.endsWith("/"))
  test("trims trailing slash from api_url before using it", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeDeploymentPage([FULL_DEPLOYMENT]), { status: 200 });
    }) as typeof fetch;

    const vault = createStubVault({
      // Trailing slash — trimTrailingSlash must strip it
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w/",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    await sync.sync(syncTestContext(db, vault, "prefect"), null);

    // The URL must not contain a double-slash before /deployments
    expect(capturedUrl).not.toContain("//deployments");
    expect(capturedUrl).toContain(
      "https://api.prefect.cloud/api/accounts/a/workspaces/w/deployments/filter",
    );
  });

  // ─── Line 66: extractDeployments — non-array parsed body → returns [] ────
  // Covers the false-branch of Array.isArray(parsed)
  test("returns no items and advances cursor when response body is a non-array JSON object", async () => {
    const db = createMemoryIndexDb();
    // Prefect filter endpoint returns a bare array; simulate a buggy server
    // returning an object instead — extractDeployments falls through to [].
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-prefect1:");
    expectServiceItemCount(db, "prefect", 0);
  });

  // ─── Line 78-79: mapped === null → continue (malformed item skipped) ──────
  // Covers the DA=0 `continue` at line 79 in upsertDeployments.
  // mapPrefectDeploymentToItem returns null when `id` is absent/empty.
  test("skips deployments missing required id field (mapped === null)", async () => {
    const db = createMemoryIndexDb();
    const noId = { name: "broken", flow_id: "f1" }; // no id → mapper returns null
    const withId = { ...FULL_DEPLOYMENT, id: "dep-uuid-good" };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeDeploymentPage([noId, withId]), { status: 200 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    // Only the valid deployment is upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "prefect", 1);
  });

  // ─── Also: non-object entry in array → asRecord returns undefined ─────────
  test("skips non-object entries in deployment array (asRecord → undefined)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        // First entry is a primitive string; second is valid
        new Response(makeDeploymentPage(["not-an-object", FULL_DEPLOYMENT]), { status: 200 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "prefect", 1);
  });

  // ─── Line 112-113 (page=0, http_error): syncPassCursorHttpEmpty ──────────
  // Covers branch: outcome.kind !== "ok" AND page === 0 AND kind === "http_error"
  test("returns http-empty result when page 0 returns HTTP error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    // Pass a cursor so we can confirm syncPassCursorHttpEmpty returns it unchanged
    const incomingCursor = "nimbus-prefect1:aGVsbG8=";
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), incomingCursor);

    expect(r.itemsUpserted).toBe(0);
    // syncPassCursorHttpEmpty returns incomingCursor ?? defaultCursor
    expect(r.cursor).toBe(incomingCursor);
    expectServiceItemCount(db, "prefect", 0);
  });

  // ─── Line 112-113 (page=0, parse_error): syncPassCursorParseEmpty ────────
  // Covers branch: outcome.kind !== "ok" AND page === 0 AND kind !== "http_error"
  test("returns parse-empty result when page 0 returns invalid JSON", async () => {
    const db = createMemoryIndexDb();
    // status 200 but body is not JSON → connectorFetch returns parse_error
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-valid-json!!!", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(0);
    // syncPassCursorParseEmpty always returns the default cursor
    expect(r.cursor).toContain("nimbus-prefect1:");
    expectServiceItemCount(db, "prefect", 0);
  });

  // ─── Line 117: break on mid-pagination error (page > 0) ──────────────────
  // Covers DA=0 line 117 `break`: outcome.kind !== "ok" AND page !== 0
  test("breaks out of pagination when a later page returns an HTTP error", async () => {
    const db = createMemoryIndexDb();
    // Return a full page (100 items) on page 0 so the loop continues;
    // return HTTP 500 on page 1 → hits the `break` at line 117.
    const PAGE_SIZE = 100;
    const page0Items = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `dep-uuid-${i}`,
      name: `deployment-${i}`,
    }));
    let callCount = 0;

    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      _init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(makeDeploymentPage(page0Items), { status: 200 });
      }
      // Page 1 returns server error → break path
      return new Response("Server Error", { status: 500 });
    }) as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(callCount).toBe(2);
    // All page-0 deployments are upserted; page-1 error triggers break
    expect(r.itemsUpserted).toBe(PAGE_SIZE);
    expect(r.cursor).toContain("nimbus-prefect1:");
    expectServiceItemCount(db, "prefect", PAGE_SIZE);
  });

  // ─── Empty results: short page terminates loop early ─────────────────────
  test("terminates loop on empty deployment array (short page)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeDeploymentPage([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-prefect1:");
  });

  // ─── Deployment with optional fields absent (fallbacks exercised) ─────────
  test("handles deployment with minimal fields (no optional fields)", async () => {
    const db = createMemoryIndexDb();
    const minimal = { id: "dep-min-1" }; // only id present
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeDeploymentPage([minimal]), { status: 200 }),
      )) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "prefect", 1);
  });

  // ─── Existing cursor is passed through on http_error (null cursor) ────────
  test("uses default cursor when incoming cursor is null and http error on page 0", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;

    const vault = createStubVault({
      "prefect.api_url": "https://api.prefect.cloud/api/accounts/a/workspaces/w",
      "prefect.api_key": "pnu_test_key",
    });
    const sync = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    // null cursor → syncPassCursorHttpEmpty returns defaultCursor
    const r = await sync.sync(syncTestContext(db, vault, "prefect"), null);

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-prefect1:");
  });
});
