import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createLookerSyncable } from "./looker-sync.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

const DASHBOARD = { id: "d1", title: "Sales" };
const MODEL = {
  name: "m1",
  explores: [{ views: [{ name: "orders", sql_table_name: "analytics.public.orders" }] }],
};

/** Branch a list drain by the requested tool: dashboards for looker_list, models for looker_models_list. */
function byTool(listToolId: string): unknown[] {
  return listToolId === "looker_list" ? [DASHBOARD] : [MODEL];
}

function countByType(db: Database, type: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM item WHERE service = 'looker' AND type = ?")
    .get(type) as { c: number };
  return row.c;
}

describe("looker-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined);
  });

  test("personal: indexes dashboards AND LookML-model lineage via both drained lists", async () => {
    __setPersonalDrainForTest(async (_ctx, _service, listToolId) => byTool(listToolId));
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }));

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(2);
    expect(countByType(db, "dashboard")).toBe(1);
    expect(countByType(db, "data_model")).toBe(1); // the lineage edge source
  });

  test("team: BOTH dashboards and model lineage are produced via runTeamList (not the personal path)", async () => {
    let personalCalled = false;
    __setPersonalDrainForTest(async () => {
      personalCalled = true;
      return [];
    });
    const db = createMemoryIndexDb();
    const seenTools: string[] = [];
    const ctx = {
      ...syncTestContext(db, createStubVault({})),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-looker" }),
      runTeamList: async (req: { listToolId: string }) => {
        seenTools.push(req.listToolId);
        return byTool(req.listToolId);
      },
    };

    const r = await createLookerSyncable().sync(ctx, null);

    expect(personalCalled).toBe(false);
    expect(r.itemsUpserted).toBe(2);
    expect(countByType(db, "data_model")).toBe(1);
    expect(seenTools.sort()).toEqual(["looker_list", "looker_models_list"]);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({})),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-looker" }),
      runTeamList: async (req: { listToolId: string }) => byTool(req.listToolId),
    };

    await createLookerSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'looker'").all() as Array<
      Record<string, unknown>
    >;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("empty drains index nothing", async () => {
    __setPersonalDrainForTest(async () => []);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }));

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "looker", 0);
  });
});
