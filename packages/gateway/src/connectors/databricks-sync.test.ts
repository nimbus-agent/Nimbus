import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createDatabricksSyncable } from "./databricks-sync.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeJobsResponse(
  jobs: unknown[],
  opts: { hasMore?: boolean; nextPageToken?: string } = {},
): string {
  return JSON.stringify({
    jobs,
    has_more: opts.hasMore ?? false,
    next_page_token: opts.nextPageToken ?? "",
  });
}

function makeRunsResponse(runs: unknown[]): string {
  return JSON.stringify({ runs });
}

/** Minimal valid job fixture */
const FULL_JOB = {
  job_id: 1,
  creator_user_name: "alice@example.com",
  created_time: 1_700_000_000_000,
  settings: {
    name: "ETL Job",
    format: "MULTI_TASK",
    schedule: { quartz_cron_expression: "0 0 * * *" },
  },
};

/** Minimal valid run fixture for job_id 1 */
const FULL_RUN = {
  job_id: 1,
  run_id: 42,
  start_time: 1_700_000_100_000,
  run_duration: 5000,
  execution_duration: 4000,
  creator_user_name: "alice@example.com",
  state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
  cluster_instance: { cluster_id: "cluster-abc" },
};

const MCP_NOOP = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describeWithFetchRestore("databricks-sync", () => {
  // ── no-op when token missing ──────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when token is missing from vault",
    () => createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP }),
    createStubVault({ "databricks.host": "https://my.databricks.com", "databricks.token": null }),
  );

  // ── no-op when host missing ───────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when host is missing from vault",
    () => createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP }),
    createStubVault({ "databricks.host": null, "databricks.token": "dapi-abc" }),
  );

  // ── no-op when both missing ───────────────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when both host and token are missing",
    () => createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP }),
    createStubVault({ "databricks.host": null, "databricks.token": null }),
  );

  // ── host trailing-slash stripping (line 36 true branch) ──────────────────
  test("strips trailing slash from host URL (line 36 true branch)", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      if (typeof input === "string" && capturedUrl === "") {
        capturedUrl = input;
      }
      return new Response(makeRunsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    // Host with trailing slash — trimTrailingSlash must remove it
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com/",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );
    // The runs URL must NOT contain double-slash after host
    expect(capturedUrl).toContain("https://my.databricks.com/api/");
    expect(capturedUrl).not.toContain("com//api");
  });

  // ── host without trailing slash (line 36 false branch) ───────────────────
  test("host without trailing slash is kept as-is (line 36 false branch)", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      if (typeof input === "string" && capturedUrl === "") {
        capturedUrl = input;
      }
      return new Response(makeRunsResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );
    expect(capturedUrl).toContain("https://my.databricks.com/api/");
  });

  // ── happy path: full job + run, cursor advances ───────────────────────────
  test("indexes a job with a matching run and advances cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([FULL_RUN]), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-databricks1:");
    expectServiceItemCount(db, "databricks", 1);
  });

  // ── empty jobs list (extractArray false branch: not an array) ─────────────
  test("returns zero upserts when jobs response has no jobs array (line 50 false branch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      // Response body has no "jobs" key at all — extractArray returns []
      return new Response(JSON.stringify({ has_more: false }), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "databricks", 0);
  });

  // ── extractArray: "jobs" key exists but is not an array (line 50 false branch) ──
  test("handles non-array jobs field gracefully (line 50 false branch)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      // "jobs" is an object (not array) — extractArray returns []
      return new Response(JSON.stringify({ jobs: { unexpected: true }, has_more: false }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
  });

  // ── http_error on page 0 → syncPassCursorHttpEmpty (lines 155-156) ────────
  test("returns http-empty result on HTTP error during first jobs page (lines 155-156)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // syncPassCursorHttpEmpty: cursor preserved (null → null) but next cursor set
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-databricks1:");
    expectServiceItemCount(db, "databricks", 0);
  });

  // ── parse_error on page 0 → syncPassCursorParseEmpty (line 156 else branch) ──
  test("returns parse-empty result when first jobs page has invalid JSON (line 156 else)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      // ok=true but unparseable JSON → parse_error
      return new Response("not-valid-json!!!", { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-databricks1:");
    expectServiceItemCount(db, "databricks", 0);
  });

  // ── non-ok on page > 0 → break (line 160) ─────────────────────────────────
  test("breaks pagination loop on HTTP error mid-stream (line 160 break)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      callCount += 1;
      if (callCount === 1) {
        // Page 0: valid, signals more pages
        return new Response(
          makeJobsResponse([FULL_JOB], { hasMore: true, nextPageToken: "tok-page-2" }),
          { status: 200 },
        );
      }
      // Page 1: HTTP error → break (line 160), partial results still returned
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // Page 0 job was upserted; page 1 error caused break
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-databricks1:");
    expect(callCount).toBe(2);
  });

  // ── pagination: two valid pages (hasMore path) ────────────────────────────
  test("follows pagination across two pages (hasMore=true then false)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    const JOB_2 = { ...FULL_JOB, job_id: 2, settings: { name: "Job Two" } };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          makeJobsResponse([FULL_JOB], { hasMore: true, nextPageToken: "tok-p2" }),
          { status: 200 },
        );
      }
      // Page 2: hasMore=false → loop exits normally
      return new Response(makeJobsResponse([JOB_2]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "databricks", 2);
    expect(callCount).toBe(2);
  });

  // ── hasMore=true but empty nextPageToken → stops (line 174) ───────────────
  test("stops pagination when nextPageToken is empty even if hasMore=true", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      callCount += 1;
      // hasMore=true but next_page_token="" → loop breaks
      return new Response(makeJobsResponse([FULL_JOB], { hasMore: true, nextPageToken: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ── asRecord(outcome.parsed) falls back to {} (line 163) ──────────────────
  // The parsed payload is a JSON array — asRecord returns undefined → {} used
  test("handles non-object (array) top-level jobs response (line 163 fallback)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      // Parsed body is an array — asRecord returns undefined → {} → has_more=false → break
      return new Response(JSON.stringify([{ unexpected: true }]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(0);
  });

  // ── extractRunsByJobId: run entry that is not a record (line 65 continue) ──
  test("skips non-object run entries in runs list (line 65 continue)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        // Mix: primitive (skipped) + valid run
        return new Response(JSON.stringify({ runs: ["not-an-object", FULL_RUN] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // Job 1 still gets its run matched; primitive run was skipped
    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractRunsByJobId: run missing job_id (line 69 continue) ─────────────
  test("skips runs missing job_id field (line 69 continue)", async () => {
    const db = createMemoryIndexDb();

    const runWithoutJobId = {
      run_id: 99,
      start_time: 1_700_000_100_000,
      state: { life_cycle_state: "RUNNING", result_state: null },
      cluster_instance: {},
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(JSON.stringify({ runs: [runWithoutJobId] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // Job 1 upserted but without a run match (map is empty)
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_id"]).toBeNull();
  });

  // ── extractRunsByJobId: duplicate job_id → second skipped (line 69 map.has branch) ──
  test("only keeps first run per job_id — duplicate job_ids are skipped (line 69 map.has)", async () => {
    const db = createMemoryIndexDb();

    const run2 = { ...FULL_RUN, run_id: 99, start_time: 1_999_999_999_000 };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        // Two runs with same job_id — only first should be kept
        return new Response(JSON.stringify({ runs: [FULL_RUN, run2] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // First run_id (42) kept, not the duplicate (99)
    expect(meta["latest_run_id"]).toBe(42);
  });

  // ── state/clusterInstance absent (lines 72/73 fallback to {}) ─────────────
  test("handles runs with missing state and cluster_instance fields (lines 72-73 fallback)", async () => {
    const db = createMemoryIndexDb();

    const runNoState = {
      job_id: 1,
      run_id: 55,
      start_time: 1_700_000_500_000,
      run_duration: 3000,
      creator_user_name: "bob@example.com",
      // no "state" or "cluster_instance" fields
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(JSON.stringify({ runs: [runNoState] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_cluster_id"]).toBeNull();
    expect(meta["latest_run_status"]).toContain("?");
  });

  // ── duration: run_duration missing → falls back to execution_duration (line 74) ──
  test("falls back to execution_duration when run_duration is absent (line 74)", async () => {
    const db = createMemoryIndexDb();

    const runExecDuration = {
      job_id: 1,
      run_id: 77,
      start_time: 1_700_000_600_000,
      execution_duration: 8888,
      // no run_duration
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      cluster_instance: { cluster_id: "c-xyz" },
      creator_user_name: "carol@example.com",
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(JSON.stringify({ runs: [runExecDuration] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_duration_ms"]).toBe(8888);
  });

  // ── strOrNull null branch (line 54): state fields missing → null ──────────
  // (Covered implicitly by runNoState test above, but explicit here for clarity)
  test("strOrNull returns null when field is absent (line 54 null branch)", async () => {
    const db = createMemoryIndexDb();

    const runNoStringFields = {
      job_id: 1,
      run_id: 88,
      state: {
        // life_cycle_state is a number, not a string → stringField returns undefined → strOrNull → null
        life_cycle_state: 123,
        result_state: 456,
      },
      cluster_instance: { cluster_id: 789 },
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(JSON.stringify({ runs: [runNoStringFields] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_cluster_id"]).toBeNull();
  });

  // ── numOrNull null branch (line 58): numeric fields missing → null ─────────
  test("numOrNull returns null when field is absent (line 58 null branch)", async () => {
    const db = createMemoryIndexDb();

    const runNoNumbers = {
      job_id: 1,
      // no run_id, no start_time, no run_duration, no execution_duration
      state: { life_cycle_state: "PENDING", result_state: null },
      cluster_instance: {},
    };

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(JSON.stringify({ runs: [runNoNumbers] }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_id"]).toBeNull();
    expect(meta["latest_run_duration_ms"]).toBeNull();
  });

  // ── upsertJobs: mapped === null (line 98 continue) — job without job_id ───
  test("skips jobs that fail mapping (e.g. missing job_id) (line 98 continue)", async () => {
    const db = createMemoryIndexDb();

    const invalidJob = { settings: { name: "No ID Job" } }; // no job_id → mapDatabricksJobToItem returns null

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      return new Response(makeJobsResponse([invalidJob, FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // Only FULL_JOB was valid; invalidJob was skipped
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "databricks", 1);
  });

  // ── upsertJobs: non-record job → mapDatabricksJobToItem returns null ───────
  test("skips primitive (non-object) entries in the jobs array (line 98 continue)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([]), { status: 200 });
      }
      // Mix: primitive (null mapping), valid job
      return new Response(JSON.stringify({ jobs: ["not-a-job", FULL_JOB], has_more: false }), {
        status: 200,
      });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── runs fetch HTTP error → empty runsByJobId map (lines 136-138) ─────────
  test("proceeds with empty runs map when runs fetch returns HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    // Job still indexed even with empty runs
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'databricks' LIMIT 1")
      .get() as { metadata: string } | undefined;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["latest_run_id"]).toBeNull();
  });

  // ── runs fetch parse error → empty runsByJobId map ────────────────────────
  test("proceeds with empty runs map when runs response is invalid JSON", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response("~~~invalid~~~", { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── extractArray: "runs" key value is null (not array) → [] ──────────────
  test("extractArray handles null value for runs key (returns [])", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        // "runs" key is null — Array.isArray(null) = false → []
        return new Response(JSON.stringify({ runs: null }), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      null,
    );

    expect(r.itemsUpserted).toBe(1);
  });

  // ── cursor passed in is non-null (sync still works) ───────────────────────
  test("accepts a non-null incoming cursor and still syncs", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/runs/list")) {
        return new Response(makeRunsResponse([FULL_RUN]), { status: 200 });
      }
      return new Response(makeJobsResponse([FULL_JOB]), { status: 200 });
    }) as typeof fetch;

    const sync = createDatabricksSyncable({ ensureDatabricksMcpRunning: MCP_NOOP });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "databricks.host": "https://my.databricks.com",
          "databricks.token": "dapi-abc",
        }),
        "databricks",
      ),
      "nimbus-databricks1:eyJwYXNzIjoxfQ", // pre-built valid cursor
    );

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-databricks1:");
  });
});
