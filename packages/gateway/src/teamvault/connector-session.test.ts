import { afterEach, describe, expect, it, mock } from "bun:test";
import type { MCPClient } from "@mastra/mcp";
import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  __setSessionSpawnerForTest,
  realSpawn,
  spawnerFor,
  withConnectorSession,
} from "./connector-session.ts";

const fakeVault: NimbusVault = {
  get: async () => "secret",
  set: async () => {},
  delete: async () => {},
  listKeys: async () => [],
};

describe("withConnectorSession", () => {
  afterEach(() => __setSessionSpawnerForTest(undefined));

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
  });

  it("throws when no server is spawned (realSpawn returns undefined client)", async () => {
    __setSessionSpawnerForTest(() => undefined);
    await expect(
      withConnectorSession(
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/no server spawned for service "snowflake"/);
  });

  it("rejects a call for an unknown tool id (tool not registered)", async () => {
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({ snowflake_list: { execute: async () => ({}) } }),
      disconnect: async () => {},
    }));
    await expect(
      withConnectorSession(
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
        async (s) => s.call("does_not_exist", { cursor: null }),
      ),
    ).rejects.toThrow(/tool "does_not_exist" not found for service "snowflake"/);
  });

  it("rejects a call when the matched tool has no execute fn", async () => {
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({ snowflake_list: {} }),
      disconnect: async () => {},
    }));
    await expect(
      withConnectorSession(
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
        async (s) => s.call("snowflake_list", { cursor: null }),
      ),
    ).rejects.toThrow(/tool "snowflake_list" not found/);
  });
});

describe("realSpawn (deterministic client-assembly, injected spawner)", () => {
  function fakeMcpClient(): MCPClient {
    return {
      listTools: async () => ({ snowflake_list: { execute: async () => ({ ok: true }) } }),
      disconnect: async () => {},
    } as unknown as MCPClient;
  }

  it("wraps the single registered client into a SessionClient and lists its tools", async () => {
    const spawner = async (ctx: MeshSpawnContext): Promise<void> => {
      ctx.setLazyClient("snowflake-slot", fakeMcpClient());
    };
    const client = await realSpawn(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
      () => spawner,
    );
    expect(client).toBeDefined();
    const tools = await client?.listTools();
    expect(Object.keys(tools ?? {})).toContain("snowflake_list");
    await client?.disconnect();
  });

  it("returns undefined when the spawner registers no client", async () => {
    const noopSpawner = async (): Promise<void> => {};
    const client = await realSpawn(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
      () => noopSpawner,
    );
    expect(client).toBeUndefined();
  });

  it("swallows a disconnect rejection (best-effort cleanup)", async () => {
    const spawner = async (ctx: MeshSpawnContext): Promise<void> => {
      ctx.setLazyClient("slot", {
        listTools: async () => ({}),
        disconnect: async () => {
          throw new Error("disconnect failed");
        },
      } as unknown as MCPClient);
    };
    const client = await realSpawn(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
      () => spawner,
    );
    // .catch(() => {}) inside disconnect must absorb the rejection.
    await expect(client?.disconnect()).resolves.toBeUndefined();
  });
});

describe("spawnerFor (service → spawner mapping)", () => {
  it("returns the dedicated single-service spawner for a known service", () => {
    expect(spawnerFor("github")).toBe(spawners.ensureGithubMcp);
  });

  it("falls back to the phase-3 bundle spawner for an unmapped service", () => {
    expect(spawnerFor("snowflake")).toBe(spawners.ensurePhase3BundleMcp);
  });
});
