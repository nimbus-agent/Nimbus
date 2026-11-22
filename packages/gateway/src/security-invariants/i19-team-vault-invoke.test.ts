import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I19 — team-vault secret injection is leak-proof + fail-closed", () => {
  test("federation.invoke routes through the answerFederatedInvoke gate (sole consumption path)", async () => {
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toContain("answerFederatedInvoke");
  });

  test("a missing team secret fails CLOSED before any spawn (never the operator credential)", async () => {
    const { invokeTeamTool } = await import("../teamvault/team-tool-invoke.ts");
    const vault = {
      get: async () => null, // team entry has no secret
      set: async () => {},
      delete: async () => {},
      listKeys: async () => [],
    };
    let spawned = false;
    await expect(
      invokeTeamTool(
        {
          vault,
          sandboxCwd: "/tmp",
          requiredSecretKeysFor: () => ["github.pat"],
          spawnAndCall: async () => {
            spawned = true;
            return {};
          },
        },
        { entry: "e", service: "github", toolId: "t", args: {} },
      ),
    ).rejects.toThrow();
    expect(spawned).toBe(false);
  });

  test("a localOperator team list fails CLOSED on a missing secret (no session opened)", async () => {
    const { invokeTeamToolList } = await import("../teamvault/team-tool-invoke.ts");
    let opened = false;
    await expect(
      invokeTeamToolList(
        {
          vault: {
            get: async () => null,
            set: async () => {},
            delete: async () => {},
            listKeys: async () => [],
          },
          sandboxCwd: "/tmp",
          requiredSecretKeysFor: () => ["snowflake.account"],
          openSession: async () => {
            opened = true;
            return [];
          },
        },
        { entry: "e", service: "snowflake", listToolId: "snowflake_list" },
      ),
    ).rejects.toThrow();
    expect(opened).toBe(false);
  });

  test("a team-credentialed list reaches the secret ONLY via the gate, never the personal drain", async () => {
    const { listConnectorItems, __setPersonalDrainForTest } = await import(
      "../connectors/warehouse-sync-transport.ts"
    );
    let personalCalled = false;
    let teamCalled = false;
    __setPersonalDrainForTest(async () => {
      personalCalled = true;
      return [];
    });
    try {
      await listConnectorItems(
        {
          vault: {
            get: async () => "x",
            set: async () => {},
            delete: async () => {},
            listKeys: async () => [],
          },
          sandboxCwd: "/tmp",
          credentialFor: () => ({ credential: "team", teamEntry: "prod-snowflake" }),
          runTeamList: async () => {
            teamCalled = true;
            return [];
          },
        } as never,
        "snowflake",
        "snowflake_list",
      );
    } finally {
      __setPersonalDrainForTest(undefined);
    }
    expect(teamCalled).toBe(true);
    expect(personalCalled).toBe(false);
  });
});
