// packages/gateway/src/connectors/warehouse-write-transport.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  __setPersonalInvokeForTest,
  invokeConnectorWrite,
  type WarehouseWriteContext,
} from "./warehouse-write-transport.ts";

afterEach(() => __setPersonalInvokeForTest(undefined));

function ctx(over: Partial<WarehouseWriteContext>): WarehouseWriteContext {
  return {
    vault: {} as never,
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" }),
    runTeamInvoke: async () => ({ team: true }),
    ...over,
  };
}

describe("invokeConnectorWrite", () => {
  test("personal path calls the injected personal invoke", async () => {
    let seen: { service: string; toolId: string; args: unknown } | undefined;
    __setPersonalInvokeForTest(async (_c, service, toolId, args) => {
      seen = { service, toolId, args };
      return { personal: true };
    });
    const out = await invokeConnectorWrite(ctx({}), {
      service: "tableau",
      writeToolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
    expect(out).toEqual({ personal: true });
    expect(seen).toEqual({
      service: "tableau",
      toolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
  });

  test("team path routes through runTeamInvoke with the configured entry", async () => {
    let seen: unknown;
    const out = await invokeConnectorWrite(
      ctx({
        credentialFor: () => ({ credential: "team", teamEntry: "wh" }),
        runTeamInvoke: async (req) => {
          seen = req;
          return { team: true };
        },
      }),
      { service: "powerbi", writeToolId: "powerbi_dataset_refresh", args: { groupId: "g" } },
    );
    expect(out).toEqual({ team: true });
    expect(seen).toEqual({
      entry: "wh",
      service: "powerbi",
      toolId: "powerbi_dataset_refresh",
      args: { groupId: "g" },
    });
  });

  test("team credential without a team_entry fails closed", async () => {
    await expect(
      invokeConnectorWrite(ctx({ credentialFor: () => ({ credential: "team" }) }), {
        service: "powerbi",
        writeToolId: "powerbi_dataset_refresh",
        args: {},
      }),
    ).rejects.toThrow(/team_entry/);
  });
});
