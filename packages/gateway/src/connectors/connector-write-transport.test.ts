// packages/gateway/src/connectors/connector-write-transport.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { __setSessionSpawnerForTest } from "../teamvault/connector-session.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  __setPersonalInvokeForTest,
  type ConnectorWriteContext,
  invokeConnectorWrite,
} from "./connector-write-transport.ts";

afterEach(() => {
  __setPersonalInvokeForTest(undefined);
  __setSessionSpawnerForTest(undefined);
});

function ctx(over: Partial<ConnectorWriteContext>): ConnectorWriteContext {
  return {
    vault: {} as never,
    sandboxCwd: "/tmp",
    isConnectorAllowed: () => true,
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

  test("default personal path spawns a session and calls the write tool", async () => {
    let executedArgs: unknown;
    let disconnected = false;
    __setSessionSpawnerForTest(async () => ({
      listTools: async () => ({
        looker_dashboard_run: {
          execute: async (input: unknown) => {
            executedArgs = input;
            return { ran: true };
          },
        },
      }),
      disconnect: async () => {
        disconnected = true;
      },
    }));
    const out = await invokeConnectorWrite(ctx({ vault: {} as unknown as NimbusVault }), {
      service: "looker",
      writeToolId: "looker_dashboard_run",
      args: { dashboardId: "d-1" },
    });
    expect(out).toEqual({ ran: true });
    expect(executedArgs).toEqual({ dashboardId: "d-1" });
    expect(disconnected).toBe(true);
  });

  test("default personal path runs the write a real session lists as <service>_<tool>", async () => {
    // A real session lists through MCPClient, so the tableau connector's
    // `tableau_datasource_refresh` is keyed `tableau_tableau_datasource_refresh`; the transport is
    // handed the bare id the write registry holds.
    const ran: Array<{ key: string; input: unknown }> = [];
    __setSessionSpawnerForTest(async () => ({
      listTools: async () => ({
        tableau_tableau_datasource_refresh: {
          execute: async (input: unknown) => {
            ran.push({ key: "tableau_tableau_datasource_refresh", input });
            return { status: "queued", jobId: "j-1" };
          },
        },
      }),
      disconnect: async () => {},
    }));
    const out = await invokeConnectorWrite(ctx({ vault: {} as unknown as NimbusVault }), {
      service: "tableau",
      writeToolId: "tableau_datasource_refresh",
      args: { id: "ds-1" },
    });
    expect(out).toEqual({ status: "queued", jobId: "j-1" });
    expect(ran).toEqual([{ key: "tableau_tableau_datasource_refresh", input: { id: "ds-1" } }]);
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

// The transport spawns its OWN session, never the mesh, so the mesh's I22 policy filter does not
// see it. These run the REAL default personal path (only the spawn is faked, serving the key a real
// session lists) and the team hand-off, and prove a blocked connector reaches neither.
describe("invokeConnectorWrite — the org policy's connector allowlist (I22)", () => {
  const WRITE = { service: "tableau", writeToolId: "tableau_datasource_refresh", args: {} };

  /** Count spawns, executions and team hand-offs; the listed key is the one a real session has. */
  function observed(): {
    spawns: () => number;
    ran: string[];
    team: unknown[];
    credentialReads: string[];
  } {
    let spawns = 0;
    const ran: string[] = [];
    __setSessionSpawnerForTest(() => {
      spawns += 1;
      return {
        listTools: async () => ({
          tableau_tableau_datasource_refresh: {
            execute: async () => {
              ran.push("tableau_tableau_datasource_refresh");
              return { status: "queued" };
            },
          },
        }),
        disconnect: async () => {},
      };
    });
    return { spawns: () => spawns, ran, team: [], credentialReads: [] };
  }

  for (const credential of ["personal", "team"] as const) {
    test(`refuses a connector the policy blocks before anything runs (${credential} credential)`, async () => {
      const o = observed();
      const asked: string[] = [];
      const c = ctx({
        vault: {} as unknown as NimbusVault,
        isConnectorAllowed: (service) => {
          asked.push(service);
          return false;
        },
        credentialFor: (service) => {
          o.credentialReads.push(service);
          return credential === "team"
            ? { credential: "team", teamEntry: "wh" }
            : { credential: "personal" };
        },
        runTeamInvoke: async (req) => {
          o.team.push(req);
          return { team: true };
        },
      });

      await expect(invokeConnectorWrite(c, WRITE)).rejects.toThrow(
        "connectors.tableau: blocked by the org policy's connector allowlist (I22); tableau_datasource_refresh was not run",
      );
      expect(asked).toEqual(["tableau"]);
      // Nothing past the check: no credential selected, no team hand-off, no process, no tool.
      expect(o.credentialReads).toEqual([]);
      expect(o.team).toEqual([]);
      expect(o.spawns()).toBe(0);
      expect(o.ran).toEqual([]);
    });
  }

  test("an allowed connector's write runs, and the allowlist is read on every call", async () => {
    const o = observed();
    let allowed = true;
    const c = ctx({
      vault: {} as unknown as NimbusVault,
      isConnectorAllowed: (service) => service === "tableau" && allowed,
    });

    expect(await invokeConnectorWrite(c, WRITE)).toEqual({ status: "queued" });
    expect(o.ran).toEqual(["tableau_tableau_datasource_refresh"]);

    // A newly verified policy that drops the connector applies to the very next write.
    allowed = false;
    await expect(invokeConnectorWrite(c, WRITE)).rejects.toThrow(/I22/);
    expect(o.spawns()).toBe(1);
    expect(o.ran).toEqual(["tableau_tableau_datasource_refresh"]);
  });
});
