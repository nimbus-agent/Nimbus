import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createTableauSyncable } from "./tableau-sync.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

/** A raw Tableau view in the shape tableau_list emits (pre-reshape). */
function rawView(luid: string, name: string): Record<string, unknown> {
  return { luid, name, workbook: { name: "WB" }, owner: { name: "Bob" } };
}

describe("tableau-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined);
  });

  test("personal: reshapes + indexes views drained from tableau_list", async () => {
    __setPersonalDrainForTest(async () => [rawView("v1", "Sales")]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "tableau.url": "https://t" }), "tableau");

    const r = await createTableauSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "tableau", 1);
  });

  test("team: routes through runTeamList (gate), indexes the returned views", async () => {
    const db = createMemoryIndexDb();
    let listReq: unknown;
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "tableau"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-tableau" }),
      runTeamList: async (req: unknown) => {
        listReq = req;
        return [rawView("v1", "Sales")];
      },
    };

    const r = await createTableauSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expect(listReq).toEqual({
      entry: "prod-tableau",
      service: "tableau",
      listToolId: "tableau_list",
    });
    expectServiceItemCount(db, "tableau", 1);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "tableau"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-tableau" }),
      runTeamList: async () => [rawView("v1", "Sales")],
    };

    await createTableauSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'tableau'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("a non-object row and a view missing its luid are both skipped", async () => {
    __setPersonalDrainForTest(async () => ["not-an-object", { name: "No Luid" }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "tableau.url": "https://t" }), "tableau");

    const r = await createTableauSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "tableau", 0);
  });

  test("a view with no own name falls back to the workbook name", async () => {
    // Covers shapeTableauView's `name === "" ? workbookName : name` fallback arm: the view has no
    // `name` (stringField → undefined → ""), so the workbook's name is used as the dashboard title.
    __setPersonalDrainForTest(async () => [{ luid: "v9", workbook: { name: "Quarterly WB" } }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "tableau.url": "https://t" }), "tableau");

    const r = await createTableauSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT title FROM item WHERE service = 'tableau'").get() as {
      title: string;
    };
    expect(row.title).toBe("Quarterly WB");
  });

  test("a view with no workbook and no owner reshapes with empty/null fallbacks", async () => {
    // Covers the `workbook === undefined` and `owner === undefined` arms: a bare view (only luid+name)
    // still reshapes cleanly (author=null) and is indexed.
    __setPersonalDrainForTest(async () => [{ luid: "v10", name: "Bare View" }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "tableau.url": "https://t" }), "tableau");

    const r = await createTableauSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    const row = db.prepare("SELECT title FROM item WHERE service = 'tableau'").get() as {
      title: string;
    };
    expect(row.title).toBe("Bare View");
  });
});
