import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createPowerBiSyncable } from "./powerbi-sync.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

/** A report as powerbi_list emits it — dataset-table refs already expanded by the connector. */
function report(id: string): Record<string, unknown> {
  return {
    id,
    name: `Report ${id}`,
    workspace: "WS",
    datasetId: "ds1",
    datasetTables: ["analytics.public.orders"],
  };
}

function upstreamKeys(db: Database): string[] {
  const row = db.prepare("SELECT metadata FROM item WHERE service = 'powerbi' LIMIT 1").get() as {
    metadata: string;
  } | null;
  if (row === null) return [];
  const meta = JSON.parse(row.metadata) as { upstreamDataModelKeys?: string[] };
  return meta.upstreamDataModelKeys ?? [];
}

describe("powerbi-sync (unified spawn transport)", () => {
  afterEach(() => {
    __setPersonalDrainForTest(undefined);
  });

  test("personal: indexes reports drained from powerbi_list", async () => {
    __setPersonalDrainForTest(async () => [report("r1")]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "powerbi.tenant_id": "t" }), "powerbi");

    const r = await createPowerBiSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "powerbi", 1);
  });

  test("team: report items AND dataset-table lineage are produced via runTeamList", async () => {
    const db = createMemoryIndexDb();
    let listReq: unknown;
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "powerbi"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-powerbi" }),
      runTeamList: async (req: unknown) => {
        listReq = req;
        return [report("r1")];
      },
    };

    const r = await createPowerBiSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(1);
    expect(listReq).toEqual({
      entry: "prod-powerbi",
      service: "powerbi",
      listToolId: "powerbi_list",
    });
    // The lineage edge comes from the connector-expanded datasetTables (no gateway second fetch).
    expect(upstreamKeys(db).length).toBeGreaterThanOrEqual(1);
  });

  test("team no-leak: a secret-shaped value never lands in an indexed row", async () => {
    const SECRET = "tv-secret-do-not-leak";
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({}), "powerbi"),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-powerbi" }),
      runTeamList: async () => [report("r1")],
    };

    await createPowerBiSyncable().sync(ctx, null);

    const rows = db.prepare("SELECT * FROM item WHERE service = 'powerbi'").all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      for (const v of Object.values(row)) {
        expect(String(v)).not.toContain(SECRET);
      }
    }
  });

  test("a report missing its id is skipped", async () => {
    __setPersonalDrainForTest(async () => [{ name: "No Id", datasetTables: [] }]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "powerbi.tenant_id": "t" }), "powerbi");

    const r = await createPowerBiSyncable().sync(ctx, null);

    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "powerbi", 0);
  });
});
