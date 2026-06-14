import { describe, expect, it, mock } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { __setSessionSpawnerForTest, withConnectorSession } from "./connector-session.ts";

const fakeVault: NimbusVault = {
  get: async () => "secret",
  set: async () => {},
  delete: async () => {},
  listKeys: async () => [],
};

describe("withConnectorSession", () => {
  it("spawns once, allows N calls, then disconnects once", async () => {
    let spawns = 0;
    let disconnects = 0;
    const execute = mock(async (args: unknown) => ({
      content: [{ type: "text", text: JSON.stringify({ echo: args }) }],
    }));
    __setSessionSpawnerForTest(() => {
      spawns += 1;
      return {
        listTools: async () => ({ snowflake_list: { execute } }),
        disconnect: async () => {
          disconnects += 1;
        },
      };
    });

    const calls = await withConnectorSession(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
      async (s) => {
        const a = await s.call("snowflake_list", { cursor: null });
        const b = await s.call("snowflake_list", { cursor: "1" });
        return [a, b];
      },
    );

    expect(spawns).toBe(1);
    expect(disconnects).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    __setSessionSpawnerForTest(undefined);
  });

  it("disconnects even when the body throws", async () => {
    let disconnects = 0;
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({ snowflake_list: { execute: async () => ({}) } }),
      disconnect: async () => {
        disconnects += 1;
      },
    }));
    await expect(
      withConnectorSession(
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(disconnects).toBe(1);
    __setSessionSpawnerForTest(undefined);
  });
});
