import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyncCapabilities } from "../sync/sync-capabilities.ts";
import { __setSessionSpawnerForTest } from "../teamvault/connector-session.ts";
import { EMPTY_NIMBUS_VAULT } from "./connector-sync-test-helpers.ts";
import { __setPersonalDrainForTest, listConnectorItems } from "./warehouse-sync-transport.ts";

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
});
