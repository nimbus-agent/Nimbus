import { afterEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPClient } from "@mastra/mcp";
import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  __setSessionSpawnerForTest,
  realSpawn,
  spawnerFor,
  withConnectorSession,
} from "./connector-session.ts";

// Opaque cwd handed to the (faked) spawner — built cross-platform per repo convention.
const SANDBOX_CWD = join(tmpdir(), "nimbus-connector-session-test");

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
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
        { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
        async (s) => s.call("snowflake_list", { cursor: null }),
      ),
    ).rejects.toThrow(/tool "snowflake_list" not found/);
  });
});

// A real session lists tools through `MCPClient.listTools()`, which keys each one `<server>_<tool>`
// and the spawners name each server by its service id — so the snowflake connector's
// `snowflake_list` arrives as `snowflake_snowflake_list`. The fakes above are keyed by bare ids,
// the one shape a real session never has; these are keyed the way it does.
describe("withConnectorSession — tool maps keyed the way MCPClient lists them", () => {
  afterEach(() => __setSessionSpawnerForTest(undefined));

  /** Serve `keys` as a listed tool map; each tool records its own key when executed. */
  function serveListed(keys: readonly string[], ran: string[]): void {
    __setSessionSpawnerForTest(() => ({
      listTools: async () =>
        Object.fromEntries(
          keys.map((key) => [
            key,
            {
              execute: async (args: unknown) => {
                ran.push(key);
                return { key, args };
              },
            },
          ]),
        ),
      disconnect: async () => {},
    }));
  }

  it("calls a tool by its bare id on the session's own server", async () => {
    const ran: string[] = [];
    serveListed(["snowflake_snowflake_list", "snowflake_snowflake_tag_set"], ran);
    const out = await withConnectorSession(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
      async (s) => [
        await s.call("snowflake_list", { cursor: null }),
        await s.call("snowflake_tag_set", { object: "DB.S.T", tag: "pii" }),
      ],
    );
    expect(ran).toEqual(["snowflake_snowflake_list", "snowflake_snowflake_tag_set"]);
    expect(out[1]).toEqual({
      key: "snowflake_snowflake_tag_set",
      args: { object: "DB.S.T", tag: "pii" },
    });
  });

  it("still answers a caller that names the listed key exactly", async () => {
    const ran: string[] = [];
    serveListed(["snowflake_snowflake_list"], ran);
    await withConnectorSession(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
      (s) => s.call("snowflake_snowflake_list", { cursor: null }),
    );
    expect(ran).toEqual(["snowflake_snowflake_list"]);
  });

  it("never resolves a bare id onto another server the client carries", async () => {
    // The github spawner's ONE client carries `github` and `github_actions`; `github_` +
    // `actions_gha_run_trigger` spells github_actions' trigger, which a github session must not run.
    const ran: string[] = [];
    serveListed(
      ["github_github_pr_list", "github_actions_gha_run_list", "github_actions_gha_run_trigger"],
      ran,
    );
    const session = { service: "github", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD };
    await expect(
      withConnectorSession(session, (s) => s.call("actions_gha_run_trigger", {})),
    ).rejects.toThrow(/tool "actions_gha_run_trigger" not found for service "github"/);
    await expect(withConnectorSession(session, (s) => s.call("gha_run_list", {}))).rejects.toThrow(
      /tool "gha_run_list" not found for service "github"/,
    );
    expect(ran).toEqual([]);
    // Control: the session's own server answers its bare id.
    await withConnectorSession(session, (s) => s.call("github_pr_list", {}));
    expect(ran).toEqual(["github_github_pr_list"]);
  });

  // `callListed` is the lookup for an id an authorization was granted on (a federated peer's
  // invoke): the string the grant, its revocation and the quorum rule matched must be the one key
  // that runs, so a second spelling of the same tool must not.
  it("callListed runs only the exact listed key, never a bare id `call` would resolve", async () => {
    const ran: string[] = [];
    serveListed(["snowflake_snowflake_list", "snowflake_snowflake_tag_set"], ran);
    const session = { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD };
    // Premise: on the SAME session, `call` resolves the bare id — the tool is there to be found.
    await withConnectorSession(session, (s) => s.call("snowflake_tag_set", {}));
    expect(ran).toEqual(["snowflake_snowflake_tag_set"]);
    ran.length = 0;

    for (const bare of ["snowflake_tag_set", "snowflake_list"]) {
      await expect(withConnectorSession(session, (s) => s.callListed(bare, {}))).rejects.toThrow(
        `connector-session: tool "${bare}" not found for service "snowflake"`,
      );
    }
    expect(ran).toEqual([]);
    // Control: the listed key itself runs, with its args.
    expect(
      await withConnectorSession(session, (s) =>
        s.callListed("snowflake_snowflake_list", { cursor: null }),
      ),
    ).toEqual({ key: "snowflake_snowflake_list", args: { cursor: null } });
    expect(ran).toEqual(["snowflake_snowflake_list"]);
  });

  it("callListed runs only an OWN listed key, never an inherited member, however tool-shaped", async () => {
    // A map whose prototype carries a tool-shaped member — what prototype pollution would add. The
    // session's tools are its own listed keys; an inherited name is no tool, executable or not.
    const ran: string[] = [];
    let disconnects = 0;
    const inherited = {
      polluted_tool: {
        execute: async () => {
          ran.push("polluted_tool");
          return "inherited";
        },
      },
    };
    __setSessionSpawnerForTest(() => ({
      listTools: async () =>
        Object.assign(Object.create(inherited) as LazyMeshToolMap, {
          snowflake_snowflake_list: { execute: async () => "listed" },
        }),
      disconnect: async () => {
        disconnects += 1;
      },
    }));
    const session = { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD };
    for (const member of ["polluted_tool", "constructor", "toString", "__proto__"]) {
      await expect(withConnectorSession(session, (s) => s.callListed(member, {}))).rejects.toThrow(
        `connector-session: tool "${member}" not found for service "snowflake"`,
      );
    }
    expect(ran).toEqual([]);
    expect(disconnects).toBe(4);
    // Control: the own listed key on the same map runs.
    expect(
      await withConnectorSession(session, (s) => s.callListed("snowflake_snowflake_list", {})),
    ).toBe("listed");
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
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: SANDBOX_CWD },
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
