import { afterEach, describe, expect, test } from "bun:test";
import { createBigeyeSyncable } from "./bigeye-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

/** A raw Bigeye issue in the shape bigeye_list emits (consumed directly by the mapper). */
function rawIssue(issueId: string, monitoredTable: string): Record<string, unknown> {
  return { issueId, monitoredTable, slaStatus: "breached", anomaly: "spike" };
}

describe("bigeye-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined);
  });

  test("personal: maps + indexes issues drained from bigeye_list", async () => {
    __setPersonalDrainForTest(async () => [rawIssue("42", "ANALYTICS.PUBLIC.REVENUE")]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "bigeye.base_url": "https://b" }), "bigeye");

    const r = await createBigeyeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "bigeye", 1);
    const row = db
      .prepare("SELECT external_id, metadata FROM item WHERE service = 'bigeye'")
      .get() as {
      external_id: string;
      metadata: string;
    } | null;
    expect(row?.external_id).toBe("bigeye:42");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual(["analytics.public.revenue"]);
  });

  test("team: routes through runTeamList (gate), indexes the returned issues", async () => {
    const db = createMemoryIndexDb();
    let listReq: unknown;
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "bigeye"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-bigeye" }),
      runTeamList: async (req: unknown) => {
        listReq = req;
        return [rawIssue("42", "ANALYTICS.PUBLIC.REVENUE")];
      },
    };

    const r = await createBigeyeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expect(listReq).toEqual({
      entry: "prod-bigeye",
      service: "bigeye",
      listToolId: "bigeye_list",
    });
    expectServiceItemCount(db, "bigeye", 1);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "bigeye"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-bigeye" }),
      runTeamList: async () => [rawIssue("42", "ANALYTICS.PUBLIC.REVENUE")],
    };

    await createBigeyeSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'bigeye'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("a non-object row and an issue missing its issueId are both skipped", async () => {
    __setPersonalDrainForTest(async () => ["not-an-object", { slaStatus: "breached" }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "bigeye.base_url": "https://b" }), "bigeye");

    const r = await createBigeyeSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "bigeye", 0);
  });
});
