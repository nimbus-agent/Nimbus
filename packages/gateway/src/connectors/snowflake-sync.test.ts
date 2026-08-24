import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createSnowflakeSyncable } from "./snowflake-sync.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

/** A raw `snowflake_list` row in the shape the connector emits (lowercase named columns). */
function tableRow(name: string): Record<string, unknown> {
  return {
    database_name: "DB",
    schema_name: "PUBLIC",
    table_name: name,
    row_count: "100",
    last_altered: "2026-01-01T00:00:00Z",
  };
}

describe("snowflake-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined); // the override is module-global — reset between tests
  });

  test("personal: indexes items drained from snowflake_list", async () => {
    __setPersonalDrainForTest(async () => [tableRow("ORDERS")]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(
      db,
      createStubVault({ "snowflake.account": "acme-xy12345" }),
      "snowflake",
    );

    const r = await createSnowflakeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expect(r.cursor).toBeNull(); // pagination is drained inside the transport — cursor passes through
    expectServiceItemCount(db, "snowflake", 1);
  });

  test("team: routes through runTeamList (gate), indexes the returned items", async () => {
    const db = createMemoryIndexDb();
    let listReq: unknown;
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "snowflake"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-snowflake" }),
      runTeamList: async (req: unknown) => {
        listReq = req;
        return [tableRow("ORDERS")];
      },
    };

    const r = await createSnowflakeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expect(listReq).toEqual({
      entry: "prod-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list",
    });
    expectServiceItemCount(db, "snowflake", 1);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "snowflake"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-snowflake" }),
      // The transport returns only mapped raw items; the team secret is never in this array.
      runTeamList: async () => [tableRow("ORDERS")],
    };

    await createSnowflakeSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'snowflake'").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("rows the mapper rejects (missing table_name) are skipped, not upserted", async () => {
    __setPersonalDrainForTest(async () => [
      { database_name: "DB", schema_name: "PUBLIC" }, // no table_name → mapper returns null
    ]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(
      db,
      createStubVault({ "snowflake.account": "acme-xy12345" }),
      "snowflake",
    );

    const r = await createSnowflakeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "snowflake", 0);
  });
});
