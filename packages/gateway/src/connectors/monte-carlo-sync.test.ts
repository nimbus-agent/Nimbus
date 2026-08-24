import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createMonteCarloSyncable } from "./monte-carlo-sync.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

/** A raw Monte Carlo incident node in the shape montecarlo_list emits. */
function rawIncident(incidentId: string, monitoredTable: string): Record<string, unknown> {
  return { incidentId, monitoredTable, status: "open", severity: "high" };
}

describe("monte-carlo-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined);
  });

  test("personal: maps + indexes incidents drained from montecarlo_list", async () => {
    __setPersonalDrainForTest(async () => [rawIncident("42", "ANALYTICS.PUBLIC.REVENUE")]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "montecarlo.api_id": "id" }), "montecarlo");

    const r = await createMonteCarloSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "montecarlo", 1);
    const row = db
      .prepare("SELECT external_id, metadata FROM item WHERE service = 'montecarlo'")
      .get() as {
      external_id: string;
      metadata: string;
    } | null;
    expect(row?.external_id).toBe("montecarlo:42");
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual(["analytics.public.revenue"]);
  });

  test("team: routes through runTeamList (gate), indexes the returned incidents", async () => {
    const db = createMemoryIndexDb();
    let listReq: unknown;
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "montecarlo"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-montecarlo" }),
      runTeamList: async (req: unknown) => {
        listReq = req;
        return [rawIncident("42", "ANALYTICS.PUBLIC.REVENUE")];
      },
    };

    const r = await createMonteCarloSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expect(listReq).toEqual({
      entry: "prod-montecarlo",
      service: "montecarlo",
      listToolId: "montecarlo_list",
    });
    expectServiceItemCount(db, "montecarlo", 1);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "montecarlo"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-montecarlo" }),
      runTeamList: async () => [rawIncident("42", "ANALYTICS.PUBLIC.REVENUE")],
    };

    await createMonteCarloSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'montecarlo'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("a non-object row and an incident missing its incidentId are both skipped", async () => {
    __setPersonalDrainForTest(async () => ["not-an-object", { status: "open" }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "montecarlo.api_id": "id" }), "montecarlo");

    const r = await createMonteCarloSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "montecarlo", 0);
  });
});
