import { afterEach, describe, expect, it } from "bun:test";
import { __setPersonalDrainForTest, listConnectorItems } from "./warehouse-sync-transport.ts";

function ctx(
  over: Partial<Parameters<typeof listConnectorItems>[0]>,
): Parameters<typeof listConnectorItems>[0] {
  return {
    vault: {
      get: async () => "x",
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [],
    },
    db: {} as Parameters<typeof listConnectorItems>[0]["db"],
    logger: {} as Parameters<typeof listConnectorItems>[0]["logger"],
    rateLimiter: {} as Parameters<typeof listConnectorItems>[0]["rateLimiter"],
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [{ team: true }],
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
});
