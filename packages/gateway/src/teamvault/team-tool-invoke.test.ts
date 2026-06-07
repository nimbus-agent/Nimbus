import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  type InvokeTeamToolDeps,
  invokeTeamTool,
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
