import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

function fakeVault(entries: Record<string, string>): NimbusVault {
  return {
    get: async (k) => entries[k] ?? null,
    set: async () => {},
    delete: async () => {},
    listKeys: async (p) =>
      Object.keys(entries).filter((k) => (p === undefined ? true : k.startsWith(p))),
  };
}

describe("createServiceScopedVaultView", () => {
  it("passes through keys for the scoped service", async () => {
    const v = createServiceScopedVaultView(fakeVault({ "snowflake.account": "acme" }), "snowflake");
    expect(await v.get("snowflake.account")).toBe("acme");
  });

  it("returns null for other services' keys", async () => {
    const v = createServiceScopedVaultView(fakeVault({ "tableau.url": "https://t" }), "snowflake");
    expect(await v.get("tableau.url")).toBeNull();
  });

  it("listKeys is filtered to the service prefix", async () => {
    const v = createServiceScopedVaultView(
      fakeVault({ "snowflake.account": "a", "tableau.url": "u" }),
      "snowflake",
    );
    expect(await v.listKeys()).toEqual(["snowflake.account"]);
  });

  it("listKeys with an explicit sub-prefix scopes under the service prefix", async () => {
    // Covers the `listPrefix !== undefined` arm: a caller-supplied prefix is nested under `<service>.`,
    // and the result is still re-filtered to the service keyspace.
    const v = createServiceScopedVaultView(
      fakeVault({ "snowflake.account": "a", "snowflake.token": "t", "tableau.url": "u" }),
      "snowflake",
    );
    expect(await v.listKeys("acc")).toEqual(["snowflake.account"]);
  });

  it("refuses writes (read-only spawn scope)", async () => {
    const v = createServiceScopedVaultView(fakeVault({}), "snowflake");
    await expect(v.set("snowflake.account", "x")).rejects.toThrow(/read-only/);
    await expect(v.delete("snowflake.account")).rejects.toThrow(/read-only/);
  });
});
