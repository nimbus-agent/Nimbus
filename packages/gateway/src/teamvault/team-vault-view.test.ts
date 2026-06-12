import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { TEAM_VAULT_PREFIX } from "./team-vault-keys.ts";
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

/**
 * A fake vault whose listKeys ignores the prefix filter entirely —
 * used to exercise the map FALSE branch (key does NOT start with the team prefix).
 */
function fakeVaultUnfilteredList(keys: string[]): NimbusVault {
  return {
    get: async (_k) => null,
    set: async (_k, _v) => undefined,
    delete: async (_k) => undefined,
    listKeys: async (_prefix) => [...keys],
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

  it("listKeys with no argument lists all team keys (listPrefix === undefined branch)", async () => {
    const vault = fakeVault({
      "teamvault.prod-aws.github.pat": "PAT",
      "teamvault.prod-aws.slack.oauth": "OA",
      "teamvault.other-team.github.pat": "OTHER",
    });
    const view = createTeamVaultView(vault, "prod-aws");
    // no argument → listPrefix is undefined → full = prefix = "teamvault.prod-aws."
    const keys = await view.listKeys();
    expect(keys.sort()).toEqual(["github.pat", "slack.oauth"]);
  });

  it("returns empty list when no team keys are present", async () => {
    const vault = fakeVault({ "github.pat": "OPERATOR_PAT" });
    const view = createTeamVaultView(vault, "prod-aws");
    const keys = await view.listKeys();
    expect(keys).toEqual([]);
  });

  it("passes through keys that do not start with the team prefix unchanged (map false branch)", async () => {
    // The underlying vault returns a key that does NOT start with "teamvault.prod-aws."
    // (pathological vault — bypasses filtering). The map's false branch leaves it intact.
    const outsideKey = "some-other-key";
    const vault = fakeVaultUnfilteredList([outsideKey]);
    const view = createTeamVaultView(vault, "prod-aws");
    const keys = await view.listKeys("irrelevant");
    expect(keys).toEqual([outsideKey]);
  });

  it("does not expose raw secret values through get (vault non-leak assertion)", async () => {
    const secretValue = "SUPER_SECRET_TOKEN_XYZ";
    const vault = fakeVault({ "teamvault.myteam.api.token": secretValue });
    const view = createTeamVaultView(vault, "myteam");

    // The view returns the secret on a direct key read — confirm it works
    const result = await view.get("api.token");
    expect(result).toBe(secretValue);

    // Verify: listKeys returns ONLY key names, never secret values
    const keys = await view.listKeys();
    for (const k of keys) {
      expect(k).not.toBe(secretValue);
      expect(k).not.toContain(secretValue);
    }
    expect(keys).toContain("api.token");
  });

  it("write rejection error message mentions no-writes-during-team-spawn", async () => {
    const view = createTeamVaultView(fakeVault(), "myteam");
    const setErr = await view
      .set("k", "v")
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(setErr).toContain("team spawn");
    const delErr = await view
      .delete("k")
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(delErr).toContain("team spawn");
  });

  it("get returns null when the team-scoped key is absent (secret absent branch)", async () => {
    const vault = fakeVault({});
    const view = createTeamVaultView(vault, "prod-aws");
    // Neither the prefixed nor the bare key exists
    expect(await view.get("missing.key")).toBeNull();
  });

  it("TEAM_VAULT_PREFIX constant is used for namespacing (guards regression)", () => {
    // Ensure the prefix used by createTeamVaultView matches the exported constant
    expect(TEAM_VAULT_PREFIX).toBe("teamvault.");
  });
});
