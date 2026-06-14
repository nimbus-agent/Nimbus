import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  type InvokeTeamToolDeps,
  type InvokeTeamToolListDeps,
  invokeTeamTool,
  invokeTeamToolList,
  type TeamToolSpawnRequest,
} from "./team-tool-invoke.ts";

function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

function deps(over: Partial<InvokeTeamToolDeps> = {}): {
  d: InvokeTeamToolDeps;
  spawnCalls: TeamToolSpawnRequest[];
} {
  const spawnCalls: TeamToolSpawnRequest[] = [];
  const d: InvokeTeamToolDeps = {
    vault: fakeVault({ "teamvault.prod-aws.github.pat": "TEAMPAT" }),
    sandboxCwd: "/tmp/sbx",
    requiredSecretKeysFor: (service) => (service === "github" ? ["github.pat"] : undefined),
    spawnAndCall: async (req) => {
      spawnCalls.push(req);
      return { ok: true, tool: req.toolId };
    },
    ...over,
  };
  return { d, spawnCalls };
}

function listDeps(over: Partial<InvokeTeamToolListDeps> = {}): {
  d: InvokeTeamToolListDeps;
  sessionCalled: { value: boolean };
} {
  const sessionCalled = { value: false };
  const d: InvokeTeamToolListDeps = {
    vault: fakeVault({ "teamvault.dw-snowflake.snowflake.account": "ACCT123" }),
    sandboxCwd: "/tmp/sbx",
    requiredSecretKeysFor: (service) =>
      service === "snowflake" ? ["snowflake.account"] : undefined,
    openSession: async () => {
      sessionCalled.value = true;
      return [{ schema: "PUBLIC" }, { schema: "RAW" }];
    },
    ...over,
  };
  return { d, sessionCalled };
}

describe("invokeTeamTool (I19)", () => {
  it("spawns + returns the tool result when the team secret is present", async () => {
    const { d, spawnCalls } = deps();
    const r = await invokeTeamTool(d, {
      entry: "prod-aws",
      service: "github",
      toolId: "github_create_issue",
      args: { title: "x" },
    });
    expect(r).toEqual({ ok: true, tool: "github_create_issue" });
    expect(spawnCalls.length).toBe(1);
    // The spawn seam receives a team-scoped view that reads the team secret, not an operator key.
    expect(await spawnCalls[0]!.vaultView.get("github.pat")).toBe("TEAMPAT");
  });

  it("fails CLOSED (no spawn) when a required team secret is missing", async () => {
    const { d, spawnCalls } = deps({
      vault: fakeVault({}), // no team secret stored
    });
    await expect(
      invokeTeamTool(d, { entry: "prod-aws", service: "github", toolId: "t", args: {} }),
    ).rejects.toThrow(/missing required secret/);
    expect(spawnCalls.length).toBe(0);
  });

  it("never falls through to the operator's own credential", async () => {
    // Operator has github.pat, but the team entry does NOT → must fail closed, not use operator creds.
    const { d, spawnCalls } = deps({ vault: fakeVault({ "github.pat": "OPERATOR_PAT" }) });
    await expect(
      invokeTeamTool(d, { entry: "prod-aws", service: "github", toolId: "t", args: {} }),
    ).rejects.toThrow(/missing required secret/);
    expect(spawnCalls.length).toBe(0);
  });

  it("rejects an unknown / OAuth-only service (no static secret keys)", async () => {
    const { d, spawnCalls } = deps();
    await expect(
      invokeTeamTool(d, { entry: "prod-aws", service: "google_drive", toolId: "t", args: {} }),
    ).rejects.toThrow(/no team-injectable secret keys/);
    expect(spawnCalls.length).toBe(0);
  });

  it("does not expose the secret value in the returned result", async () => {
    const { d } = deps();
    const r = await invokeTeamTool(d, {
      entry: "prod-aws",
      service: "github",
      toolId: "t",
      args: {},
    });
    expect(JSON.stringify(r)).not.toContain("TEAMPAT");
  });
});

describe("invokeTeamToolList (I19 — paginated list drain)", () => {
  it("returns the array openSession resolves when the team secret is present", async () => {
    const { d, sessionCalled } = listDeps();
    const result = await invokeTeamToolList(d, {
      entry: "dw-snowflake",
      service: "snowflake",
      listToolId: "snowflake_list_schemas",
    });
    expect(result).toEqual([{ schema: "PUBLIC" }, { schema: "RAW" }]);
    expect(sessionCalled.value).toBe(true);
  });

  it("throws team_secret_missing and does NOT call openSession when the secret is absent", async () => {
    const { d, sessionCalled } = listDeps({
      vault: fakeVault({}), // no team secret stored
    });
    await expect(
      invokeTeamToolList(d, {
        entry: "dw-snowflake",
        service: "snowflake",
        listToolId: "snowflake_list_schemas",
      }),
    ).rejects.toThrow(/team_secret_missing|missing required secret/);
    expect(sessionCalled.value).toBe(false);
  });

  it("throws team_service_unsupported and does NOT call openSession for an unknown service", async () => {
    const { d, sessionCalled } = listDeps();
    await expect(
      invokeTeamToolList(d, {
        entry: "dw-snowflake",
        service: "google_drive",
        listToolId: "gdrive_list_files",
      }),
    ).rejects.toThrow(/team_service_unsupported|no team-injectable secret keys/);
    expect(sessionCalled.value).toBe(false);
  });
});
