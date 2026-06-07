import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createTeamVaultView } from "./team-vault-view.ts";

function fakeVault(
  seed: Record<string, string> = {},
): NimbusVault & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

describe("createTeamVaultView", () => {
  it("redirects a bare connector-key read into the team keyspace", async () => {
    const vault = fakeVault({ "teamvault.prod-aws.github.pat": "TEAMPAT" });
    const view = createTeamVaultView(vault, "prod-aws");
    expect(await view.get("github.pat")).toBe("TEAMPAT");
  });

  it("does NOT fall through to the operator's own connector key", async () => {
    // Operator has their own github.pat, but the team entry has none → must read null, not the operator's.
    const vault = fakeVault({ "github.pat": "OPERATOR_PAT" });
    const view = createTeamVaultView(vault, "prod-aws");
    expect(await view.get("github.pat")).toBeNull();
  });

  it("passes an already-namespaced key through unchanged", async () => {
    const vault = fakeVault({ "teamvault.prod-aws.slack.oauth": "T" });
    const view = createTeamVaultView(vault, "prod-aws");
    expect(await view.get("teamvault.prod-aws.slack.oauth")).toBe("T");
  });

  it("refuses writes and deletes (read-only)", async () => {
    const view = createTeamVaultView(fakeVault(), "prod-aws");
    await expect(view.set("github.pat", "x")).rejects.toThrow(/read-only/);
    await expect(view.delete("github.pat")).rejects.toThrow(/read-only/);
  });

  it("strips the team namespace off listed keys", async () => {
    const vault = fakeVault({
      "teamvault.prod-aws.aws.access_key_id": "a",
      "teamvault.prod-aws.aws.secret_access_key": "b",
      "github.pat": "unrelated",
    });
    const view = createTeamVaultView(vault, "prod-aws");
    const keys = await view.listKeys("aws.");
    expect(keys.sort()).toEqual(["aws.access_key_id", "aws.secret_access_key"]);
  });
});
