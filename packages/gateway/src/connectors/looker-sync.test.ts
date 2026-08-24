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
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }), "looker");

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
      ...syncTestContext(db, createStubVault({}), "looker"),
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
      ...syncTestContext(db, createStubVault({}), "looker"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-looker" }),
      // Inject the secret as an extra field on every drained item so the assertion is non-vacuous:
      // it proves the mapper indexes only known fields and never copies arbitrary connector output
      // (where a leaked team credential could otherwise ride along) into a row.
      runTeamList: async (req: { listToolId: string }) =>
        byTool(req.listToolId).map((item) => ({
          ...(item as Record<string, unknown>),
          leakedSecret: SECRET,
        })),
    };

    await createLookerSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'looker'").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("empty drains index nothing", async () => {
    __setPersonalDrainForTest(async () => []);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }), "looker");

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "looker", 0);
  });

  test("a non-array drain result yields zero items (defensive Array.isArray guards)", async () => {
    // Covers dashboardsFromResponse + viewsFromModelsResponse `!Array.isArray(parsed)` arms: a
    // malformed (non-array) drain payload is treated as empty rather than throwing.
    __setPersonalDrainForTest(async () => ({ not: "an array" }) as unknown as unknown[]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }), "looker");

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "looker", 0);
  });

  test("non-object and unmappable dashboard items are skipped", async () => {
    // looker_list returns: a non-object (asRecord → undefined) + a dashboard missing its title
    // (mapper returns null → the `mapped !== null` false arm). Both produce zero upserts.
    __setPersonalDrainForTest(async (_ctx, _service, listToolId) =>
      listToolId === "looker_list" ? ["not-an-object", { id: "d2" }] : [],
    );
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }), "looker");

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expect(countByType(db, "dashboard")).toBe(0);
  });

  test("malformed model entries are skipped at every nesting level", async () => {
    // looker_models_list returns model entries that exercise each defensive arm of
    // viewsFromModel / viewsFromExplore:
    //   - a non-object model            (asRecord → undefined)
    //   - a model with no name          (modelName === "" guard)
    //   - a model with no explores array (Array.isArray(explores) false)
    //   - a non-object explore           (asRecord(exploreItem) → undefined)
    //   - an explore with no views array (Array.isArray(views) false)
    //   - a non-object view              (asRecord(viewItem) → undefined)
    //   - a view with no sql_table_name  (mapper returns null → `mapped !== null` false arm)
    const models: unknown[] = [
      "not-an-object",
      { explores: [] }, // no name
      { name: "m_no_explores" }, // explores not an array
      { name: "m_bad_explore", explores: ["not-an-object"] }, // non-object explore
      { name: "m_no_views", explores: [{ id: 1 }] }, // explore with no views array
      { name: "m_bad_view", explores: [{ views: ["not-an-object"] }] }, // non-object view
      { name: "m_unmappable", explores: [{ views: [{ name: "v_no_sql" }] }] }, // view w/o sql_table_name
    ];
    __setPersonalDrainForTest(async (_ctx, _service, listToolId) =>
      listToolId === "looker_models_list" ? models : [],
    );
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "looker.base_url": "https://l" }), "looker");

    const r = await createLookerSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expect(countByType(db, "data_model")).toBe(0);
  });
});
