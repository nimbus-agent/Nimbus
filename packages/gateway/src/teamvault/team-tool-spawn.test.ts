import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { __setSessionSpawnerForTest } from "./connector-session.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";
import { spawnTeamToolAndCall, spawnTeamWriteAndCall } from "./team-tool-spawn.ts";

// `spawnTeamToolAndCall` (the federated anchor's seam) and `spawnTeamWriteAndCall` (the local team
// write's) are thin wrappers over `withConnectorSession` (the spawn-once/N-calls primitive). The
// spawn lifecycle itself — spawnerFor selection, realSpawn client assembly, the not-found /
// disconnect semantics — is unit-tested in `connector-session.test.ts`. Here we only prove each
// wrapper opens one session and makes exactly one call with the request's tool + args, and which
// lookup it makes: the exact listed key (federated) or the resolved bare id (local write).

const TEST_CWD = join(tmpdir(), "nimbus-team-tool-spawn-test");

const fakeVault: NimbusVault = {
  get: () => Promise.resolve(null),
  set: () => Promise.reject(new Error("read-only")),
  delete: () => Promise.reject(new Error("read-only")),
  listKeys: () => Promise.resolve([]),
};

function req(over: Partial<TeamToolSpawnRequest> = {}): TeamToolSpawnRequest {
  return {
    service: "github",
    toolId: "list_issues",
    args: { a: 1 },
    vaultView: fakeVault,
    sandboxCwd: TEST_CWD,
    ...over,
  };
}

function sessionClient(
  tools: LazyMeshToolMap,
  onDisconnect: () => void = () => {},
): { listTools: () => Promise<LazyMeshToolMap>; disconnect: () => Promise<void> } {
  return {
    listTools: () => Promise.resolve(tools),
    disconnect: () => {
      onDisconnect();
      return Promise.resolve();
    },
  };
}

describe("spawnTeamToolAndCall (thin wrapper over withConnectorSession)", () => {
  afterEach(() => {
    __setSessionSpawnerForTest(undefined);
  });

  test("opens one session, calls the requested tool once with its args, returns the result", async () => {
    let spawns = 0;
    let disconnects = 0;
    const calls: unknown[] = [];
    __setSessionSpawnerForTest((r) => {
      spawns += 1;
      expect(r.service).toBe("github");
      expect(r.vaultView).toBe(fakeVault);
      return sessionClient(
        {
          list_issues: {
            execute: (args: unknown) => {
              calls.push(args);
              return Promise.resolve({ got: args });
            },
          },
        },
        () => {
          disconnects += 1;
        },
      );
    });

    const result = await spawnTeamToolAndCall(req());

    expect(result).toEqual({ got: { a: 1 } });
    expect(spawns).toBe(1);
    expect(disconnects).toBe(1);
    expect(calls).toEqual([{ a: 1 }]);
  });

  test("runs a peer-named id only as the exact key a real session lists, never resolved", async () => {
    // The FEDERATED anchor's seam. A real session lists the github connector's `github_issue_list`
    // as `github_github_issue_list`; the owner's grant is keyed on the string the peer names, so
    // only that listed key may run — the bare spelling is not a second name for it.
    const calls: unknown[] = [];
    __setSessionSpawnerForTest(() =>
      sessionClient({
        github_github_issue_list: {
          execute: (args: unknown) => {
            calls.push(args);
            return Promise.resolve({ listed: true });
          },
        },
      }),
    );

    await expect(spawnTeamToolAndCall(req({ toolId: "github_issue_list" }))).rejects.toThrow(
      /tool "github_issue_list" not found for service "github"/,
    );
    expect(calls).toEqual([]);
    // Control: the listed key runs.
    expect(await spawnTeamToolAndCall(req({ toolId: "github_github_issue_list" }))).toEqual({
      listed: true,
    });
    expect(calls).toEqual([{ a: 1 }]);
  });

  test("propagates the not-found error (and still disconnects) when the tool is absent", async () => {
    let disconnects = 0;
    __setSessionSpawnerForTest(() =>
      sessionClient({ other_tool: { execute: () => Promise.resolve(1) } }, () => {
        disconnects += 1;
      }),
    );

    await expect(spawnTeamToolAndCall(req())).rejects.toThrow(
      /tool "list_issues" not found for service "github"/,
    );
    expect(disconnects).toBe(1);
  });
});

describe("spawnTeamWriteAndCall (the local team write's seam)", () => {
  afterEach(() => {
    __setSessionSpawnerForTest(undefined);
  });

  test("resolves the write registry's bare id to the key a real session lists, once", async () => {
    // `localOpInvokeCtx` in platform/assemble.ts: the owner's HITL-approved write, team-credentialed.
    // Its id is the gateway's own (`snowflake_tag_set`); a real session lists it
    // `snowflake_snowflake_tag_set`.
    let spawns = 0;
    let disconnects = 0;
    const calls: unknown[] = [];
    __setSessionSpawnerForTest((r) => {
      spawns += 1;
      expect(r.service).toBe("snowflake");
      return sessionClient(
        {
          snowflake_snowflake_tag_set: {
            execute: (args: unknown) => {
              calls.push(args);
              return Promise.resolve({ tagged: true });
            },
          },
        },
        () => {
          disconnects += 1;
        },
      );
    });

    const result = await spawnTeamWriteAndCall(
      req({ service: "snowflake", toolId: "snowflake_tag_set" }),
    );

    expect(result).toEqual({ tagged: true });
    expect(calls).toEqual([{ a: 1 }]);
    expect([spawns, disconnects]).toEqual([1, 1]);
  });

  test("never resolves the bare id onto a sibling server the same client carries", async () => {
    // The github spawner's one client carries `github` AND `github_actions`.
    const calls: string[] = [];
    __setSessionSpawnerForTest(() =>
      sessionClient({
        github_actions_gha_run_trigger: {
          execute: () => {
            calls.push("github_actions_gha_run_trigger");
            return Promise.resolve(1);
          },
        },
      }),
    );

    await expect(
      spawnTeamWriteAndCall(req({ service: "github", toolId: "actions_gha_run_trigger" })),
    ).rejects.toThrow(/tool "actions_gha_run_trigger" not found for service "github"/);
    expect(calls).toEqual([]);
  });
});
