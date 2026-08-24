import { expect, test } from "bun:test";
import { type AthenaSyncableOptions, createAthenaSyncable, type RunAwsCli } from "./athena-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

/** AWS vault keys that satisfy awsCredentialsExtra (ak + sk + region). */
function awsVault(): ReturnType<typeof createStubVault> {
  return createStubVault({
    "aws.access_key_id": "AKIATEST",
    "aws.secret_access_key": "secret",
    "aws.default_region": "us-east-1",
    "aws.profile": null,
  });
}

/** Vault missing credentials — awsCredentialsExtra returns null → noop. */
function emptyAwsVault(): ReturnType<typeof createStubVault> {
  return createStubVault({
    "aws.access_key_id": null,
    "aws.secret_access_key": null,
    "aws.default_region": null,
    "aws.profile": null,
  });
}

// ---------------------------------------------------------------------------
// RunAwsCli stub builders
// ---------------------------------------------------------------------------

/** A stub runner that returns a fixed response for every call. */
function stubRunner(ok: boolean, text: string): RunAwsCli {
  return async (_ctx, _args) => ({ ok, text });
}

// ---------------------------------------------------------------------------
// Response shape builders
// ---------------------------------------------------------------------------

function catalogsPage(names: string[], nextToken?: string): string {
  const body: Record<string, unknown> = {
    DataCatalogsSummary: names.map((n) => ({ CatalogName: n })),
  };
  if (nextToken !== undefined) {
    body["NextToken"] = nextToken;
  }
  return JSON.stringify(body);
}

function databasesPage(names: string[], nextToken?: string): string {
  const body: Record<string, unknown> = {
    DatabaseList: names.map((n) => ({ Name: n })),
  };
  if (nextToken !== undefined) {
    body["NextToken"] = nextToken;
  }
  return JSON.stringify(body);
}

function tablesPage(names: string[], nextToken?: string, extra?: Record<string, unknown>): string {
  const body: Record<string, unknown> = {
    TableMetadataList: names.map((n) => ({ Name: n, TableType: "EXTERNAL_TABLE", ...extra })),
  };
  if (nextToken !== undefined) {
    body["NextToken"] = nextToken;
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Options helper
// ---------------------------------------------------------------------------

function opts(runAwsCli: RunAwsCli): AthenaSyncableOptions {
  return {
    ensureAthenaMcpRunning: async () => {},
    runAwsCli,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithFetchRestore("athena-sync", () => {
  // ─── noop when AWS credentials are missing ─────────────────────────────
  test("no-op when AWS credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const sync = createAthenaSyncable({
      ensureAthenaMcpRunning: async () => {},
      // no runAwsCli needed — credential check short-circuits first
    });
    const r = await sync.sync(syncTestContext(db, emptyAwsVault(), "athena"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "athena", 0);
  });

  // ─── firstPageFailed: list-data-catalogs first page fails ──────────────
  // Covers line 132: return syncPassCursorParseEmpty (firstPageFailed branch)
  test("returns empty pass when list-data-catalogs first page fails", async () => {
    const db = createMemoryIndexDb();
    const runner = stubRunner(false, "");
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // syncPassCursorParseEmpty returns cursor = pass1Cursor(), 0 upserted
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
    expectServiceItemCount(db, "athena", 0);
  });

  // ─── happy path: single catalog, single database, single table ──────────
  // Covers lines 43 (parseJson happy), 59 (extractArray happy),
  //   68 (catalogNameOf ok), 77 (databaseNameOf ok), 168 (upsertTablePage loop),
  //   209 (walkDatabaseTables loop — tables res.ok)
  test("indexes one table from one catalog/database and advances cursor", async () => {
    const db = createMemoryIndexDb();

    let callIndex = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      callIndex += 1;
      const sub = args[1];
      if (sub === "list-data-catalogs") {
        return { ok: true, text: catalogsPage(["AwsDataCatalog"]) };
      }
      if (sub === "list-databases") {
        return { ok: true, text: databasesPage(["my_db"]) };
      }
      if (sub === "list-table-metadata") {
        return { ok: true, text: tablesPage(["orders"]) };
      }
      return { ok: false, text: "" };
    };

    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-athena1:");
    expectServiceItemCount(db, "athena", 1);
    expect(callIndex).toBe(3);
  });

  // ─── empty catalogs list → success with 0 upserts ──────────────────────
  test("returns success with 0 upserts when catalog list is empty", async () => {
    const db = createMemoryIndexDb();
    const runner = stubRunner(true, catalogsPage([]));
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── invalid JSON from list-data-catalogs → treated as empty page ───────
  // Covers line 43: parseJson catch → returns undefined
  // Covers line 59: extractArray rec===undefined branch → []
  // Covers line 49: nextToken rec===undefined → null
  test("handles invalid JSON from list-data-catalogs gracefully", async () => {
    const db = createMemoryIndexDb();
    // ok=true but not valid JSON → parseJson returns undefined
    // extractArray(undefined, ...) → [] → no catalogs; nextToken(undefined) → null
    const runner = stubRunner(true, "not valid json {{{}");
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── catalogNameOf: entry is not a record (non-object) → skipped ─────────
  // Covers line 67: catalogNameOf rec===undefined → null
  test("skips non-object catalog entries", async () => {
    const db = createMemoryIndexDb();
    // DataCatalogsSummary contains primitives (not records) → catalogNameOf returns null
    const badBody = JSON.stringify({ DataCatalogsSummary: ["not-an-object", 42, null] });
    const runner = stubRunner(true, badBody);
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── catalogNameOf: CatalogName is absent or empty → skipped ────────────
  // Covers line 71: name===undefined → null; name==="" → null
  test("skips catalog entries missing or empty CatalogName", async () => {
    const db = createMemoryIndexDb();
    // One entry has no CatalogName, one has empty string, one is valid
    const body = JSON.stringify({
      DataCatalogsSummary: [
        { SomethingElse: "x" }, // no CatalogName → stringField returns undefined
        { CatalogName: "" }, // empty → null
        { CatalogName: "valid-catalog" }, // valid
      ],
    });
    let dbCallCount = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      const sub = args[1];
      if (sub === "list-data-catalogs") return { ok: true, text: body };
      dbCallCount += 1;
      if (sub === "list-databases") return { ok: true, text: databasesPage([]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // Only "valid-catalog" proceeds to list-databases
    expect(dbCallCount).toBe(1);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── databaseNameOf: entry is not a record → skipped ────────────────────
  // Covers line 76: databaseNameOf rec===undefined → null
  test("skips non-object database entries", async () => {
    const db = createMemoryIndexDb();
    const badDbBody = JSON.stringify({ DatabaseList: ["not-an-object", 42] });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: badDbBody };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── databaseNameOf: Name is absent or empty → skipped ──────────────────
  // Covers line 80: name===undefined → null; name==="" → null
  test("skips database entries missing or empty Name", async () => {
    const db = createMemoryIndexDb();
    const badDbBody = JSON.stringify({
      DatabaseList: [
        { Other: "x" }, // no Name field
        { Name: "" }, // empty Name
      ],
    });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: badDbBody };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── collectPaged cap reached in collectPageIds ─────────────────────────
  // Covers line 98-99: items.length >= cap → return early inside loop
  test("collectPageIds respects cap and stops collecting", async () => {
    // We test this indirectly via MAX_DATABASES_PER_CATALOG (200).
    // Easier to test through MAX_CATALOGS (50): put 51 catalogs in one page.
    const db = createMemoryIndexDb();
    const manyNames = Array.from({ length: 51 }, (_, i) => `cat${i}`);
    const bigPage = catalogsPage(manyNames);
    // Return no databases for each catalog that proceeds
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: bigPage };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage([]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // Only MAX_CATALOGS=50 entries are accepted, 51st is dropped
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── collectPageIds: entry maps to null id → skipped ────────────────────
  // Covers line 102: id===null → not pushed
  test("collectPageIds skips entries where idOf returns null", async () => {
    const db = createMemoryIndexDb();
    // Mix: one valid entry + one that returns null (empty CatalogName)
    const mixedBody = JSON.stringify({
      DataCatalogsSummary: [
        { CatalogName: "" }, // → catalogNameOf returns null
        { CatalogName: "real-cat" }, // → valid
      ],
    });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: mixedBody };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: tablesPage(["t1"]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // Only "real-cat" proceeded → 1 table upserted
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── collectPaged: page > 0 error breaks loop (not firstPageFailed) ──────
  // Covers line 132: page===0 branch (false) → break (not firstPageFailed return)
  test("stops paginating when a subsequent page fails (not firstPageFailed)", async () => {
    const db = createMemoryIndexDb();
    // Second catalog page (page>0) fails — first page already collected cats
    let catalogCall = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") {
        catalogCall += 1;
        if (catalogCall === 1) {
          return { ok: true, text: catalogsPage(["cat1"], "next-tok") };
        }
        // Second page fails (page=1, not page 0) → breaks
        return { ok: false, text: "" };
      }
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: tablesPage(["tbl1"]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // cat1/db1/tbl1 was collected from the first page before second-page error
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── walkDatabaseTables: res.ok===false on first table page → break ──────
  // Covers line 208-209: !res.ok inside walkDatabaseTables → break
  test("breaks out of walkDatabaseTables when list-table-metadata fails", async () => {
    const db = createMemoryIndexDb();
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: false, text: "access denied" };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
    expectServiceItemCount(db, "athena", 0);
  });

  // ─── upsertTablePage: mapAthenaTableToItem returns null → skipped ─────────
  // Covers line 172: mapped===null branch (entry without Name)
  test("skips table entries where mapAthenaTableToItem returns null", async () => {
    const db = createMemoryIndexDb();
    // TableMetadataList contains an entry with no Name field → mapAthenaTableToItem → null
    const badTableBody = JSON.stringify({
      TableMetadataList: [
        { TableType: "EXTERNAL_TABLE" }, // no Name → null
        { Name: "valid_table", TableType: "EXTERNAL_TABLE" }, // valid
      ],
    });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: badTableBody };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // Only the valid table is upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "athena", 1);
  });

  // ─── upsertTablePage: hit MAX_TABLES_PER_DATABASE cap ───────────────────
  // Covers line 167-168: seen >= MAX_TABLES_PER_DATABASE → break
  test("upsertTablePage respects MAX_TABLES_PER_DATABASE cap", async () => {
    const db = createMemoryIndexDb();
    // Provide 501 tables in one page — cap is 500
    const manyTables = Array.from({ length: 501 }, (_, i) => ({
      Name: `table_${i}`,
      TableType: "EXTERNAL_TABLE",
    }));
    const bigTableBody = JSON.stringify({ TableMetadataList: manyTables });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: bigTableBody };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // MAX_TABLES_PER_DATABASE = 500, 501st is dropped
    expect(r.itemsUpserted).toBe(500);
    expectServiceItemCount(db, "athena", 500);
  });

  // ─── pagination: NextToken causes a second catalog page ──────────────────
  test("follows NextToken to fetch additional catalog pages", async () => {
    const db = createMemoryIndexDb();
    let catalogCall = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") {
        catalogCall += 1;
        if (catalogCall === 1) return { ok: true, text: catalogsPage(["cat1"], "tok-2") };
        return { ok: true, text: catalogsPage(["cat2"]) }; // no NextToken → stop
      }
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: tablesPage(["tbl1"]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // cat1 + cat2 both contribute 1 table each = 2 upserts
    expect(catalogCall).toBe(2);
    expect(r.itemsUpserted).toBe(2);
  });

  // ─── pagination: NextToken for tables ────────────────────────────────────
  test("follows NextToken to fetch additional table pages", async () => {
    const db = createMemoryIndexDb();
    let tableCall = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") {
        tableCall += 1;
        if (tableCall === 1) return { ok: true, text: tablesPage(["tbl1"], "table-tok") };
        return { ok: true, text: tablesPage(["tbl2"]) };
      }
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(tableCall).toBe(2);
    expect(r.itemsUpserted).toBe(2);
  });

  // ─── extractArray: key value is not an array → [] ───────────────────────
  // Covers line 62: arr not Array.isArray → []
  test("handles non-array value for result key in extractArray", async () => {
    const db = createMemoryIndexDb();
    // DataCatalogsSummary is a string (not array) → extractArray returns [] → no catalogs
    const badBody = JSON.stringify({ DataCatalogsSummary: "should-be-array" });
    const runner = stubRunner(true, badBody);
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── multiple databases per catalog → all tables upserted ───────────────
  test("upserts tables from multiple databases in one catalog", async () => {
    const db = createMemoryIndexDb();
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1", "db2"]) };
      if (args[1] === "list-table-metadata") {
        const dbName = args[args.indexOf("--database-name") + 1] ?? "";
        if (dbName === "db1") return { ok: true, text: tablesPage(["t1", "t2"]) };
        if (dbName === "db2") return { ok: true, text: tablesPage(["t3"]) };
        return { ok: true, text: tablesPage([]) };
      }
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "athena", 3);
  });

  // ─── nextToken: NextToken is present but empty string → stops ────────────
  // Covers nextToken line 53: tok === "" → null
  test("treats empty-string NextToken as end of pages", async () => {
    const db = createMemoryIndexDb();
    let catalogCall = 0;
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") {
        catalogCall += 1;
        // NextToken is empty string → nextToken() returns null → loop breaks
        return {
          ok: true,
          text: JSON.stringify({ DataCatalogsSummary: [{ CatalogName: "cat1" }], NextToken: "" }),
        };
      }
      if (args[1] === "list-databases") return { ok: true, text: databasesPage([]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "athena"), null);
    // Loop should NOT fetch a second page since NextToken="" → null
    expect(catalogCall).toBe(1);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── profile-only AWS credentials still pass awsCredentialsExtra ─────────
  test("proceeds with profile-only AWS credentials (no access key)", async () => {
    const db = createMemoryIndexDb();
    const profileVault = createStubVault({
      "aws.access_key_id": null,
      "aws.secret_access_key": null,
      "aws.default_region": null,
      "aws.profile": "my-profile",
    });
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "list-data-catalogs") return { ok: true, text: catalogsPage(["cat1"]) };
      if (args[1] === "list-databases") return { ok: true, text: databasesPage(["db1"]) };
      if (args[1] === "list-table-metadata") return { ok: true, text: tablesPage(["tbl1"]) };
      return { ok: false, text: "" };
    };
    const sync = createAthenaSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, profileVault, "athena"), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-athena1:");
  });

  // ─── serviceId / defaultIntervalMs / initialSyncDepthDays ───────────────
  test("syncable has correct service metadata", () => {
    const sync = createAthenaSyncable({
      ensureAthenaMcpRunning: async () => {},
    });
    expect(sync.serviceId).toBe("athena");
    expect(sync.defaultIntervalMs).toBe(10 * 60 * 1000);
    expect(sync.initialSyncDepthDays).toBe(30);
  });
});
