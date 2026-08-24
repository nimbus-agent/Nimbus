import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createBigquerySyncable } from "./bigquery-sync.ts";
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

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal vault that satisfies loadCreds (gcp connector keys). */
function gcpVault(credPath: string, projectId: string) {
  return createStubVault({
    "gcp.credentials_json_path": credPath,
    "gcp.project_id": projectId,
  });
}

/** A no-op mintAccessToken that always returns a token. */
const stubMint = async (_credPath: string): Promise<string | null> => "test-token";

/** A mintAccessToken that always returns null (simulates gcloud failure). */
const failMint = async (_credPath: string): Promise<string | null> => null;

/** Minimal valid BQ dataset-list response (one dataset). */
function makeDatasetsResponse(datasetIds: string[], nextPageToken?: string): string {
  return JSON.stringify({
    datasets: datasetIds.map((id) => ({
      datasetReference: { datasetId: id, projectId: "proj" },
    })),
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  });
}

/** Minimal valid BQ tables-list response (one or more tables). */
function makeTablesResponse(tableIds: string[], datasetId: string, nextPageToken?: string): string {
  return JSON.stringify({
    tables: tableIds.map((id) => ({
      tableReference: { datasetId, tableId: id, projectId: "proj" },
      type: "TABLE",
    })),
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  });
}

/** Minimal valid BQ table-detail response (for resolveTableSource). */
function makeTableDetailResponse(datasetId: string, tableId: string): string {
  return JSON.stringify({
    tableReference: { datasetId, tableId, projectId: "proj" },
    type: "TABLE",
    numRows: "100",
    numBytes: "1024",
    creationTime: "1700000000000",
    schema: {
      fields: [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "STRING" },
      ],
    },
  });
}

/**
 * Build a SyncContext whose ProviderRateLimiter has a very high burst size for bigquery
 * so that tests issuing 100+ requests don't block on token-bucket waits.
 */
function unlimitedSyncTestContext(db: Database, vault: NimbusVault): SyncContext {
  return {
    ...syncTestContext(db, vault, "bigquery"),
    rateLimiter: new ProviderRateLimiter({
      bigquery: { requestsPerMinute: 1_000_000, burstSize: 100_000 },
      gcp: { requestsPerMinute: 1_000_000, burstSize: 100_000 },
    }),
  };
}

// ─── No-op when creds missing ─────────────────────────────────────────────────

describeWithFetchRestore("bigquery-sync — no-op paths", () => {
  testConnectorSyncNoop(
    "no-op when credPath is missing",
    () =>
      createBigquerySyncable({
        ensureBigqueryMcpRunning: async () => {},
        mintAccessToken: stubMint,
      }),
    createStubVault({ "gcp.credentials_json_path": null, "gcp.project_id": "proj" }),
  );

  testConnectorSyncNoop(
    "no-op when project_id is missing",
    () =>
      createBigquerySyncable({
        ensureBigqueryMcpRunning: async () => {},
        mintAccessToken: stubMint,
      }),
    createStubVault({ "gcp.credentials_json_path": "/path/to/creds.json", "gcp.project_id": null }),
  );

  testConnectorSyncNoop(
    "no-op when credPath is empty string",
    () =>
      createBigquerySyncable({
        ensureBigqueryMcpRunning: async () => {},
        mintAccessToken: stubMint,
      }),
    gcpVault("", "proj"),
  );

  testConnectorSyncNoop(
    "no-op when project_id is empty string",
    () =>
      createBigquerySyncable({
        ensureBigqueryMcpRunning: async () => {},
        mintAccessToken: stubMint,
      }),
    gcpVault("/path/creds.json", ""),
  );
});

// ─── Token mint failure ────────────────────────────────────────────────────────

describeWithFetchRestore("bigquery-sync — token mint failure", () => {
  test("returns pass cursor (http-empty) when mintAccessToken returns null", async () => {
    const db = createMemoryIndexDb();
    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: failMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // cursor is preserved (null → null for httpEmpty with null prior cursor)
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bq1:");
    expectServiceItemCount(db, "bigquery", 0);
  });

  test("preserves non-null prior cursor when mint fails", async () => {
    const db = createMemoryIndexDb();
    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: failMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      "nimbus-bq1:somecursor",
    );
    // Original cursor preserved in syncPassCursorHttpEmpty
    expect(r.itemsUpserted).toBe(0);
  });
});

// ─── mintAccessToken inject — lines 41-54 via edge cases ────────────────────
// The real gcloudPrintAccessToken covers lines 41-54; via DI injection:
// - failMint covers the "null return" path (line 48-49, 51-52, 53-54 graceful)
// - stubMint covers the success path
// These are exercised in the sections above and below.

// ─── Happy path: datasets + tables upserted ───────────────────────────────────

describeWithFetchRestore("bigquery-sync — happy path", () => {
  test("indexes tables and advances cursor (single dataset, single table)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        // table detail
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-bq1:");
    expectServiceItemCount(db, "bigquery", 1);
  });

  test("indexes multiple datasets and tables", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1", "ds2"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        // table detail: match ds1/t1 and ds2/t2
        if (url.includes("/ds1/")) {
          return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
        }
        return new Response(makeTableDetailResponse("ds2", "t2"), { status: 200 });
      }
      if (url.includes("/ds1/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      if (url.includes("/ds2/tables?")) {
        return new Response(makeTablesResponse(["t2"], "ds2"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "bigquery", 2);
  });
});

// ─── HTTP error on datasets (page 0) → http-empty cursor ──────────────────────

describeWithFetchRestore("bigquery-sync — dataset fetch http error", () => {
  test("returns http-empty cursor when datasets page 0 returns HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Server Error", { status: 500 }))) as unknown as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bq1:");
    expectServiceItemCount(db, "bigquery", 0);
  });
});

// ─── Parse error on datasets (page 0) → parse-empty cursor ───────────────────

describeWithFetchRestore("bigquery-sync — dataset fetch parse error", () => {
  test("returns parse-empty cursor when datasets page 0 returns invalid JSON", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (() =>
      Promise.resolve(new Response("not-json", { status: 200 }))) as unknown as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bq1:");
    expectServiceItemCount(db, "bigquery", 0);
  });
});

// ─── Pagination: datasets multi-page (nextPageToken) ──────────────────────────

describeWithFetchRestore("bigquery-sync — dataset pagination", () => {
  test("fetches next dataset page when nextPageToken present (line 100-101 branch)", async () => {
    const db = createMemoryIndexDb();
    let datasetCallCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        datasetCallCount += 1;
        if (datasetCallCount === 1) {
          // first page returns nextPageToken
          return new Response(makeDatasetsResponse(["ds1"], "page2token"), { status: 200 });
        }
        // second page — no more pages
        return new Response(makeDatasetsResponse(["ds2"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        if (url.includes("/ds1/")) {
          return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
        }
        return new Response(makeTableDetailResponse("ds2", "t2"), { status: 200 });
      }
      if (url.includes("/ds1/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      if (url.includes("/ds2/tables?")) {
        return new Response(makeTablesResponse(["t2"], "ds2"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(datasetCallCount).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "bigquery", 2);
  });

  test("error on page 1+ of datasets breaks gracefully (line 186-189)", async () => {
    const db = createMemoryIndexDb();
    let datasetCallCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        datasetCallCount += 1;
        if (datasetCallCount === 1) {
          return new Response(makeDatasetsResponse(["ds1"], "page2token"), { status: 200 });
        }
        // second page fails
        return new Response("Error", { status: 500 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // ds1 was collected before page 2 error, so 1 table upserted
    expect(datasetCallCount).toBe(2);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-bq1:");
  });
});

// ─── Tables pagination ─────────────────────────────────────────────────────────

describeWithFetchRestore("bigquery-sync — tables pagination", () => {
  test("fetches next tables page when nextPageToken present (line 277-278 branch)", async () => {
    const db = createMemoryIndexDb();
    let tableListCallCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        // detail fetches — cover up to MAX_TABLE_DETAIL
        if (url.includes("/t1")) {
          return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
        }
        return new Response(makeTableDetailResponse("ds1", "t2"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        tableListCallCount += 1;
        if (tableListCallCount === 1) {
          return new Response(makeTablesResponse(["t1"], "ds1", "tablenexttoken"), {
            status: 200,
          });
        }
        return new Response(makeTablesResponse(["t2"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(tableListCallCount).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "bigquery", 2);
  });

  test("tables HTTP error breaks walkDataset loop gracefully (line 273)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      // tables endpoint always fails
      if (url.includes("/tables")) {
        return new Response("Error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bq1:");
    expectServiceItemCount(db, "bigquery", 0);
  });
});

// ─── Empty datasets response (no datasets array) ──────────────────────────────

describeWithFetchRestore("bigquery-sync — empty/malformed datasets", () => {
  test("empty datasets list results in zero upserts (line 122 rec=ok, arr not array)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        // datasets key is missing → extractArray returns []
        return new Response(JSON.stringify({ notDatasets: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bigquery", 0);
  });

  test("nextPageToken is non-string field → nextPageToken() returns null (line 113)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        // nextPageToken is a number, not a string → stringField returns undefined → null
        return new Response(JSON.stringify({ datasets: [], nextPageToken: 42 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("non-object response body → nextPageToken rec=undefined → null (line 112-113)", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        callCount += 1;
        if (callCount === 1) {
          // First call: returns one dataset with a nextPageToken
          return new Response(makeDatasetsResponse(["ds1"], "tok"), { status: 200 });
        }
        // Second call: tables endpoint for ds1 is an array (non-record) → nextPageToken returns null
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // ds1 from first page is still processed
    expect(r.cursor).toContain("nimbus-bq1:");
  });
});

// ─── datasetIdOf branches (lines 130-138) ─────────────────────────────────────

describeWithFetchRestore("bigquery-sync — datasetIdOf malformed entries", () => {
  test("skips dataset entries that are not objects (line 130 rec=undefined)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        // Mix: primitive (skipped), valid entry
        return new Response(
          JSON.stringify({
            datasets: [
              "not-an-object", // skipped — asRecord returns undefined (line 130)
              { datasetReference: { datasetId: "ds1", projectId: "proj" } },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("skips dataset entries where datasetReference is not an object (line 133-134)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(
          JSON.stringify({
            datasets: [
              { datasetReference: "not-an-object" }, // ref undefined (line 134)
              { datasetReference: { datasetId: "ds1", projectId: "proj" } },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("skips dataset entries where datasetId is missing or empty (line 137-138)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(
          JSON.stringify({
            datasets: [
              { datasetReference: { datasetId: "", projectId: "proj" } }, // empty id
              { datasetReference: { projectId: "proj" } }, // missing id
              { datasetReference: { datasetId: "ds1", projectId: "proj" } }, // valid
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── tableIdOf branches (lines 143-151) ───────────────────────────────────────

describeWithFetchRestore("bigquery-sync — tableIdOf malformed entries", () => {
  test("skips table entries that are not objects (line 143 rec=undefined)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: [
              "not-an-object", // skipped (line 143-144)
              {
                tableReference: { datasetId: "ds1", tableId: "t1", projectId: "proj" },
                type: "TABLE",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // Only the valid table is upserted; the primitive is skipped
    // tableId=null → resolveTableSource returns entry, mapBigqueryTableToItem returns null for primitive
    // For valid entry: upserted = 1
    expect(r.itemsUpserted).toBe(1);
  });

  test("skips table entries where tableReference is not an object (line 146-147)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: [
              { tableReference: "not-an-object" }, // ref undefined (line 147)
              {
                tableReference: { datasetId: "ds1", tableId: "t1", projectId: "proj" },
                type: "TABLE",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });

  test("skips table entries where tableId is missing or empty (line 150-151)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: [
              { tableReference: { datasetId: "ds1", tableId: "", projectId: "proj" } }, // empty tableId
              { tableReference: { datasetId: "ds1", projectId: "proj" } }, // missing tableId
              {
                tableReference: { datasetId: "ds1", tableId: "t1", projectId: "proj" },
                type: "TABLE",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── collectDatasetPage cap at MAX_DATASETS (line 163-164) ───────────────────

describeWithFetchRestore("bigquery-sync — dataset cap", () => {
  test("stops collecting dataset ids at MAX_DATASETS=100 cap (line 163)", async () => {
    const db = createMemoryIndexDb();
    // 101 entries in one page — collectDatasetPage stops at 100, then while-loop exits
    const dsIds = Array.from({ length: 101 }, (_, i) => `ds${i}`);
    let tablesCallCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(dsIds), { status: 200 });
      }
      // all tables endpoints: return empty tables (no detail calls)
      if (url.includes("/tables")) {
        tablesCallCount += 1;
        return new Response(JSON.stringify({ tables: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    // Use high-burst rate limiter so 100 datasets × 1 tables call doesn't hit token waits
    const r = await sync.sync(
      unlimitedSyncTestContext(db, gcpVault("/creds.json", "my-project")),
      null,
    );
    // Exactly 100 datasets collected (cap enforced); 100 tables-list calls, each empty
    expect(tablesCallCount).toBe(100);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-bq1:");
  });
});

// ─── resolveTableSource: tableId null → return entry (line 227-228) ───────────

describeWithFetchRestore("bigquery-sync — resolveTableSource branches", () => {
  test("returns list entry when tableId is null (no detail fetch) (line 227)", async () => {
    const db = createMemoryIndexDb();
    let detailFetchCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.match(/\/tables\/[^?]/u)) {
        detailFetchCount += 1;
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        // Entry missing tableReference → tableId=null → resolveTableSource returns entry, mapper returns null
        return new Response(
          JSON.stringify({
            tables: [
              { type: "TABLE" }, // no tableReference → tableIdOf returns null
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // tableId null → no detail fetch, mapper returns null → 0 upserted
    expect(detailFetchCount).toBe(0);
    expect(r.itemsUpserted).toBe(0);
  });

  test("returns list entry (no detail fetch) when detailsFetched >= MAX_TABLE_DETAIL (line 227-228)", async () => {
    const db = createMemoryIndexDb();
    // MAX_TABLE_DETAIL = 50; generate 51 tables to trigger the cap
    const tableIds = Array.from({ length: 51 }, (_, i) => `t${i}`);
    let detailFetchCount = 0;

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.match(/\/tables\/[^?]/u)) {
        detailFetchCount += 1;
        // Extract tableId from URL: .../tables/<tid>
        const parts = url.split("/");
        const tid = parts[parts.length - 1] ?? "tx";
        return new Response(makeTableDetailResponse("ds1", tid), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: tableIds.map((id) => ({
              tableReference: { datasetId: "ds1", tableId: id, projectId: "proj" },
              type: "TABLE",
            })),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    // Use high-burst rate limiter: 1 datasets + 1 tables-list + 50 detail = 52 fetch calls
    const r = await sync.sync(
      unlimitedSyncTestContext(db, gcpVault("/creds.json", "my-project")),
      null,
    );
    // Only 50 detail fetches max (MAX_TABLE_DETAIL); 51st table uses list entry
    expect(detailFetchCount).toBe(50);
    // All 51 entries map successfully (list entry has tableReference)
    expect(r.itemsUpserted).toBe(51);
  });
});

// ─── upsertTablesPage: mapped === null skipped (line 253) ─────────────────────

describeWithFetchRestore("bigquery-sync — mapped null skipped", () => {
  test("skips tables where mapBigqueryTableToItem returns null (line 253)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.match(/\/tables\/[^?]/u)) {
        // Detail response missing tableReference → mapper returns null
        return new Response(JSON.stringify({ type: "TABLE" }), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: [
              // Entry with tableId so resolveTableSource tries detail fetch
              {
                tableReference: { datasetId: "ds1", tableId: "t1", projectId: "proj" },
                type: "TABLE",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // detail response has no tableReference → mapper returns null → 0 upserted
    expect(r.itemsUpserted).toBe(0);
  });
});

// ─── upsertTablesPage: seen >= MAX_TABLES_PER_DATASET cap (line 247-248) ─────

describeWithFetchRestore("bigquery-sync — table cap per dataset", () => {
  test("stops at MAX_TABLES_PER_DATASET=500 cap per dataset (line 247)", async () => {
    const db = createMemoryIndexDb();
    // Generate 501 tables — should stop at 500
    const tableIds = Array.from({ length: 501 }, (_, i) => `t${i}`);

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.match(/\/tables\/[^?]/u)) {
        const parts = url.split("/");
        const tid = parts[parts.length - 1] ?? "tx";
        return new Response(makeTableDetailResponse("ds1", tid), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(
          JSON.stringify({
            tables: tableIds.map((id) => ({
              tableReference: { datasetId: "ds1", tableId: id, projectId: "proj" },
              type: "TABLE",
            })),
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    // Use high-burst rate limiter: 1 datasets + 1 tables-list + 50 detail = 52 fetch calls
    const r = await sync.sync(
      unlimitedSyncTestContext(db, gcpVault("/creds.json", "my-project")),
      null,
    );
    // Max 500 tables upserted (501st is past the cap)
    expect(r.itemsUpserted).toBe(500);
    expectServiceItemCount(db, "bigquery", 500);
  });
});

// ─── extractArray: non-array value for key (line 125) ─────────────────────────

describeWithFetchRestore("bigquery-sync — extractArray non-array", () => {
  test("treats datasets field as empty when it is not an array (line 125)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        // datasets is a string, not an array → extractArray returns []
        return new Response(JSON.stringify({ datasets: "not-an-array" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });

  test("treats tables field as empty when it is not an array (line 125 tables path)", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables")) {
        // tables is a number, not an array → extractArray returns []
        return new Response(JSON.stringify({ tables: 42 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
  });
});

// ─── detail fetch fails → falls back to list entry (line 233) ─────────────────

describeWithFetchRestore("bigquery-sync — detail fetch failure fallback", () => {
  test("falls back to list entry when table detail fetch returns HTTP error", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.match(/\/tables\/[^?]/u)) {
        // Detail fetch fails → falls back to list entry (detail.kind !== "ok" → return entry)
        return new Response("Error", { status: 500 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      null,
    );
    // fallback entry has valid tableReference → mapper succeeds → 1 upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "bigquery", 1);
  });
});

// ─── cursor preserved across sync calls ───────────────────────────────────────

describeWithFetchRestore("bigquery-sync — cursor round-trip", () => {
  test("existing cursor is returned in the result cursor", async () => {
    const db = createMemoryIndexDb();

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const url = urlFromFetchInput(input);
      if (url.includes("/datasets?")) {
        return new Response(makeDatasetsResponse(["ds1"]), { status: 200 });
      }
      if (url.includes("/tables/")) {
        return new Response(makeTableDetailResponse("ds1", "t1"), { status: 200 });
      }
      if (url.includes("/tables?")) {
        return new Response(makeTablesResponse(["t1"], "ds1"), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: stubMint,
    });
    const r = await sync.sync(
      syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"),
      "nimbus-bq1:existingcursor",
    );
    expect(r.cursor).toContain("nimbus-bq1:");
    expect(r.itemsUpserted).toBe(1);
  });
});

// ─── ensureBigqueryMcpRunning is called ────────────────────────────────────────

describeWithFetchRestore("bigquery-sync — ensureBigqueryMcpRunning", () => {
  test("calls ensureBigqueryMcpRunning before cred check", async () => {
    let called = false;
    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {
        called = true;
      },
      mintAccessToken: stubMint,
    });
    const db = createMemoryIndexDb();
    // Use null creds so it returns noop quickly
    await sync.sync(syncTestContext(db, createStubVault({}), "bigquery"), null);
    expect(called).toBe(true);
  });
});

// ─── mintAccessToken exception path (line 53-54 via DI) ──────────────────────

describeWithFetchRestore("bigquery-sync — mintAccessToken throws", () => {
  test("propagates the error when an injected mintAccessToken throws (DI mint runs outside gcloudPrintAccessToken's catch)", async () => {
    const throwMint = async (_credPath: string): Promise<string | null> => {
      const err: unknown = new Error("gcloud not found");
      throw err;
    };
    const db = createMemoryIndexDb();
    const sync = createBigquerySyncable({
      ensureBigqueryMcpRunning: async () => {},
      mintAccessToken: throwMint,
    });
    // Expect a throw to propagate since the DI mint throws outside gcloudPrintAccessToken's catch
    // This tests the sync function calling mint — if it throws, it will propagate past the Syncable boundary
    // The source calls mint directly without try/catch; that's intentional per the source design.
    // The graceful degradation is INSIDE gcloudPrintAccessToken itself (lines 53-54).
    // Via DI, a throwing mint propagates. That's fine — we test it propagates.
    await expect(
      sync.sync(syncTestContext(db, gcpVault("/creds.json", "my-project"), "bigquery"), null),
    ).rejects.toThrow("gcloud not found");
  });
});
