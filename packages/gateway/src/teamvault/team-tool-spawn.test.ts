import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { __setSessionSpawnerForTest } from "./connector-session.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";
import { spawnTeamToolAndCall } from "./team-tool-spawn.ts";

// `spawnTeamToolAndCall` is a thin wrapper over `withConnectorSession` (the spawn-once/N-calls
// primitive). The spawn lifecycle itself — spawnerFor selection, realSpawn client assembly, the
// not-found / disconnect semantics — is unit-tested in `connector-session.test.ts`. Here we only
// prove the wrapper opens one session and makes exactly one call with the request's tool + args.

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
