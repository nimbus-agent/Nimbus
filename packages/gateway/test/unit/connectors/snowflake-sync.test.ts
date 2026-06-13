import { expect, test } from "bun:test";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createSnowflakeSyncable } from "../../../src/connectors/snowflake-sync.ts";

function statementsResponse(rows: string[][]): Response {
  return new Response(
    JSON.stringify({
      resultSetMetaData: {
        rowType: [
          { name: "DATABASE_NAME" },
          { name: "SCHEMA_NAME" },
          { name: "TABLE_NAME" },
          { name: "ROW_COUNT" },
          { name: "LAST_ALTERED" },
        ],
      },
      data: rows,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describeWithFetchRestore("snowflake-sync", () => {
  test("indexes Snowflake tables as data_model items", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({
      "snowflake.account": "acme-xy12345",
      "snowflake.oauth_token": "tok",
    });
    globalThis.fetch = (async () =>
      statementsResponse([
        ["ANALYTICS", "PUBLIC", "REVENUE", "10", "2026-06-01T00:00:00Z"],
      ])) as typeof fetch;
    const syncable = createSnowflakeSyncable({ ensureSnowflakeMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expect(res.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "snowflake", 1);
    const row = db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'snowflake'",
      )
      .get();
    expect(row?.external_id).toBe("snowflake:analytics.public.revenue");
  });

  test("no creds → noop (zero upserts)", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({});
    const syncable = createSnowflakeSyncable({ ensureSnowflakeMcpRunning: async () => {} });
    const res = await syncable.sync(syncTestContext(db, vault), null);
    expect(res.itemsUpserted).toBe(0);
  });
});
