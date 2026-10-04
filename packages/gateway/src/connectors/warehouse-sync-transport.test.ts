import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import { __setSessionSpawnerForTest } from "../teamvault/connector-session.ts";
import type { SyncUpsertRow } from "./_lib/paginated-sync.ts";
import { EMPTY_NIMBUS_VAULT } from "./connector-sync-test-helpers.ts";
import {
  __setPersonalDrainForTest,
  createWarehouseListSyncable,
  listConnectorItems,
} from "./warehouse-sync-transport.ts";

// Opaque cwd handed to the (faked) spawner — built cross-platform per repo convention.
const SANDBOX_CWD = join(tmpdir(), "nimbus-warehouse-transport-test");

function ctx(
  over: Partial<Parameters<typeof listConnectorItems>[0]>,
): Parameters<typeof listConnectorItems>[0] {
  return {
    ...buildSyncCapabilities(
      { vault: EMPTY_NIMBUS_VAULT, db: new Database(":memory:"), depth: "full" },
      "snowflake",
    ),
    logger: {} as Parameters<typeof listConnectorItems>[0]["logger"],
    rateLimiter: {} as Parameters<typeof listConnectorItems>[0]["rateLimiter"],
    sandboxCwd: SANDBOX_CWD,
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [{ team: true }],
    depth: "full",
    ...over,
  };
}

describe("listConnectorItems", () => {
  afterEach(() => __setPersonalDrainForTest(undefined));

  it("personal: drains via a service-scoped session", async () => {
    __setPersonalDrainForTest(async () => [{ id: 1 }]);
    expect(await listConnectorItems(ctx({}), "snowflake", "snowflake_list")).toEqual([{ id: 1 }]);
  });

  it("team: routes through runTeamList with the configured entry", async () => {
    let got: unknown;
    const items = await listConnectorItems(
      ctx({
        credentialFor: () => ({ credential: "team", teamEntry: "prod-snowflake" }),
        runTeamList: async (req) => {
          got = req;
          return [{ team: true }];
        },
      }),
      "snowflake",
      "snowflake_list",
    );
    expect(items).toEqual([{ team: true }]);
    expect(got).toEqual({
      entry: "prod-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list",
    });
  });

  it("team with no teamEntry is a fail-closed config error", async () => {
    await expect(
      listConnectorItems(
        ctx({ credentialFor: () => ({ credential: "team" }) }),
        "snowflake",
        "snowflake_list",
      ),
    ).rejects.toThrow(/team_entry/);
  });

  it("personal (real drain): spawns a service-scoped session and drains the list", async () => {
    // No personal-drain override → exercise realPersonalDrain, with the mesh spawn faked.
    let disconnected = false;
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({
        snowflake_list: {
          execute: async () => ({
            content: [
              { type: "text", text: JSON.stringify({ items: [{ id: 7 }], nextCursor: null }) },
            ],
          }),
        },
      }),
      disconnect: async () => {
        disconnected = true;
      },
    }));
    try {
      const items = await listConnectorItems(ctx({}), "snowflake", "snowflake_list");
      expect(items).toEqual([{ id: 7 }]);
      expect(disconnected).toBe(true);
    } finally {
      __setSessionSpawnerForTest(undefined);
    }
  });

  it("personal (real drain): drains the list tool a real session lists as <service>_<tool>", async () => {
    // A real session lists through MCPClient, which keys the snowflake connector's
    // `snowflake_list` as `snowflake_snowflake_list`. Every personal-credential warehouse/BI sync
    // drains through this path with the bare id.
    const ran: string[] = [];
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({
        snowflake_snowflake_list: {
          execute: async () => {
            ran.push("snowflake_snowflake_list");
            return {
              content: [
                { type: "text", text: JSON.stringify({ items: [{ id: 8 }], nextCursor: null }) },
              ],
            };
          },
        },
      }),
      disconnect: async () => {},
    }));
    try {
      expect(await listConnectorItems(ctx({}), "snowflake", "snowflake_list")).toEqual([{ id: 8 }]);
      expect(ran).toEqual(["snowflake_snowflake_list"]);
    } finally {
      __setSessionSpawnerForTest(undefined);
    }
  });
});

describe("createWarehouseListSyncable", () => {
  afterEach(() => __setPersonalDrainForTest(undefined));

  /** A minimal index row; the recording `upsertItem` below only reads its `externalId`. */
  function row(externalId: string, syncedAt: number): SyncUpsertRow {
    return {
      service: "snowflake",
      type: "data_model",
      externalId,
      title: externalId,
      modifiedAt: syncedAt,
      syncedAt,
    };
  }

  /** A ctx whose upserts land in `events` (as `upsert:<externalId>`) instead of an index. */
  function recordingCtx(events: string[]): SyncContext {
    return ctx({
      upsertItem: (r) => {
        events.push(`upsert:${r.externalId}`);
      },
    });
  }

  it("drains every list in order before indexing anything, with one syncedAt for the pass", async () => {
    const events: string[] = [];
    const lists: Record<string, unknown[]> = { first_list: ["a", "skip", "b"], second_list: ["c"] };
    __setPersonalDrainForTest(async (_ctx, service, listToolId) => {
      events.push(`drain:${service}/${listToolId}`);
      return lists[listToolId] ?? [];
    });
    const syncedAts = new Set<number>();
    const map = (raw: unknown, mapping: { readonly syncedAt: number }): SyncUpsertRow | null => {
      syncedAts.add(mapping.syncedAt);
      return raw === "skip" ? null : row(String(raw), mapping.syncedAt);
    };
    const syncable = createWarehouseListSyncable("snowflake", [
      { listToolId: "first_list", map },
      { listToolId: "second_list", map },
    ]);

    const result = await syncable.sync(recordingCtx(events), "cursor-in");

    expect(events).toEqual([
      "drain:snowflake/first_list",
      "drain:snowflake/second_list",
      "upsert:a",
      "upsert:b",
      "upsert:c",
    ]);
    expect(syncedAts.size).toBe(1);
    expect(result.itemsUpserted).toBe(3);
  });

  it("starts each drain only once the previous one has finished — one connector session at a time", async () => {
    // The test above records only when each drain STARTS, so it also passes when every drain runs
    // at once (Promise.all). Each drain spawns the connector or opens a team session, and one at a
    // time is what the original sequential awaits did, so pin the end of each drain too.
    const events: string[] = [];
    __setPersonalDrainForTest(async (_ctx, _service, listToolId) => {
      events.push(`start:${listToolId}`);
      await Bun.sleep(0); // a concurrent drain would start while this one is suspended here
      events.push(`end:${listToolId}`);
      return [];
    });
    const syncable = createWarehouseListSyncable("snowflake", [
      { listToolId: "first_list", map: () => null },
      { listToolId: "second_list", map: () => null },
    ]);

    await syncable.sync(ctx({}), null);

    expect(events).toEqual([
      "start:first_list",
      "end:first_list",
      "start:second_list",
      "end:second_list",
    ]);
  });

  it("stamps every row with ONE clock reading, taken after the last drain", async () => {
    // A clock that advances on every read: a per-row, per-source or pre-drain read would show up
    // as a second syncedAt, or as one earlier than a drain. Real time is too coarse to tell them apart.
    let clock = 1_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => {
      clock += 1;
      return clock;
    });
    try {
      const drainedAt: number[] = [];
      __setPersonalDrainForTest(async (_ctx, _service, listToolId) => {
        drainedAt.push(Date.now());
        return listToolId === "first_list" ? ["a", "b"] : ["c"];
      });
      const syncedAts: number[] = [];
      const map = (raw: unknown, mapping: { readonly syncedAt: number }): SyncUpsertRow => {
        syncedAts.push(mapping.syncedAt);
        return row(String(raw), mapping.syncedAt);
      };
      const syncable = createWarehouseListSyncable("snowflake", [
        { listToolId: "first_list", map },
        { listToolId: "second_list", map },
      ]);

      await syncable.sync(recordingCtx([]), null);

      expect(drainedAt).toHaveLength(2);
      expect(syncedAts).toHaveLength(3);
      expect(new Set(syncedAts).size).toBe(1);
      expect(syncedAts[0]).toBeGreaterThan(Math.max(...drainedAt));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reshapes a drained list with `rows` before mapping it", async () => {
    const events: string[] = [];
    __setPersonalDrainForTest(async () => [{ views: ["v1", "v2"] }, { views: ["v3"] }]);
    const syncable = createWarehouseListSyncable("snowflake", [
      {
        listToolId: "models",
        rows: (drained) => drained.flatMap((model) => (model as { views: string[] }).views),
        map: (raw, mapping) => row(String(raw), mapping.syncedAt),
      },
    ]);

    const result = await syncable.sync(recordingCtx(events), null);

    expect(events).toEqual(["upsert:v1", "upsert:v2", "upsert:v3"]);
    expect(result.itemsUpserted).toBe(3);
  });

  it("indexes nothing when a later list fails to drain", async () => {
    const events: string[] = [];
    __setPersonalDrainForTest(async (_ctx, _service, listToolId) => {
      if (listToolId === "second_list") throw new Error("second drain failed");
      return ["a"];
    });
    const map = (raw: unknown, mapping: { readonly syncedAt: number }): SyncUpsertRow =>
      row(String(raw), mapping.syncedAt);
    const syncable = createWarehouseListSyncable("snowflake", [
      { listToolId: "first_list", map },
      { listToolId: "second_list", map },
    ]);

    await expect(syncable.sync(recordingCtx(events), null)).rejects.toThrow("second drain failed");
    expect(events).toEqual([]);
  });

  it.each(["cursor-in", null])(
    "passes the cursor (%p) through, with no transfer size and no further pages",
    async (cursor) => {
      __setPersonalDrainForTest(async () => []);
      const syncable = createWarehouseListSyncable("snowflake", [
        { listToolId: "snowflake_list", map: () => null },
      ]);

      const result = await syncable.sync(ctx({}), cursor);

      expect(Object.keys(result)).toEqual([
        "cursor",
        "itemsUpserted",
        "itemsDeleted",
        "hasMore",
        "durationMs",
      ]);
      expect(result).toMatchObject({ cursor, itemsUpserted: 0, itemsDeleted: 0, hasMore: false });
    },
  );

  it("is a 10-minute, 30-day syncable for the service it was built for, with no targeted fetch", () => {
    const syncable = createWarehouseListSyncable("snowflake", []);
    expect(syncable.serviceId).toBe("snowflake");
    expect(syncable.defaultIntervalMs).toBe(10 * 60 * 1000);
    expect(syncable.initialSyncDepthDays).toBe(30);
    expect(syncable.fetchOne).toBeUndefined();
  });
});
