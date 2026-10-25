import { describe, expect, test } from "bun:test";

import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createProposableServiceConfigured } from "./proposable-service-configured.ts";

function vaultWith(entries: Readonly<Record<string, string>>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
  } as unknown as NimbusVault;
}

describe("createProposableServiceConfigured", () => {
  test("obsidian is configured only when [[filesystem.roots]] were present at boot", async () => {
    const empty = vaultWith({});
    expect(
      await createProposableServiceConfigured({
        vault: empty,
        isUserMcpRegistered: () => false,
        obsidianRootCount: 0,
      })("obsidian"),
    ).toBe(false);
    expect(
      await createProposableServiceConfigured({
        vault: empty,
        isUserMcpRegistered: () => false,
        obsidianRootCount: 2,
      })("obsidian"),
    ).toBe(true);
  });

  test("RED-PROOF premise: the manifest check alone answers obsidian TRUE vacuously", async () => {
    const { isConnectorConfigured } = await import("../sync/connector-configured.ts");
    expect(await isConnectorConfigured(vaultWith({}), "obsidian")).toBe(true);
  });

  test("a catalog connector delegates to its Vault keys", async () => {
    const check = createProposableServiceConfigured({
      vault: vaultWith({ "slack.oauth": "x" }),
      isUserMcpRegistered: () => false,
      obsidianRootCount: 0,
    });
    expect(await check("slack")).toBe(true);
    expect(await check("jira")).toBe(false);
  });

  test("a user-MCP id is configured when it is registered", async () => {
    const seen: string[] = [];
    const check = createProposableServiceConfigured({
      vault: vaultWith({}),
      isUserMcpRegistered: (id) => {
        seen.push(id);
        return id === "mcp_echo";
      },
      obsidianRootCount: 0,
    });
    expect(await check("mcp_echo")).toBe(true);
    expect(await check("mcp_other")).toBe(false);
    expect(seen).toEqual(["mcp_echo", "mcp_other"]);
  });
});
