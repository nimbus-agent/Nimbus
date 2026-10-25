import { describe, expect, test } from "bun:test";

import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { listProposableActionTypes } from "./proposable-actions.ts";
import { createProposableServiceConfigured } from "./proposable-service-configured.ts";

function vaultWith(entries: Readonly<Record<string, string>>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
  } as unknown as NimbusVault;
}

describe("createProposableServiceConfigured", () => {
  test("a mesh-only server answers from its own check, never the vacuous manifest", async () => {
    const empty = vaultWith({});
    expect(
      await createProposableServiceConfigured({
        vault: empty,
        isUserMcpRegistered: () => false,
        meshOnly: { obsidian: () => false },
      })("obsidian"),
    ).toBe(false);
    expect(
      await createProposableServiceConfigured({
        vault: empty,
        isUserMcpRegistered: () => false,
        meshOnly: { obsidian: () => true },
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
      meshOnly: { obsidian: () => false },
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
      meshOnly: { obsidian: () => false },
    });
    expect(await check("mcp_echo")).toBe(true);
    expect(await check("mcp_other")).toBe(false);
    expect(seen).toEqual(["mcp_echo", "mcp_other"]);
  });

  test("capture.status advertises obsidian.note.append only when obsidian can spawn", async () => {
    const list = (canSpawn: boolean) =>
      listProposableActionTypes({
        modelAccessServices: () => new Set<string>(),
        userMcpModelAccessAllowed: () => false,
        isServiceConfigured: createProposableServiceConfigured({
          vault: vaultWith({}),
          isUserMcpRegistered: () => false,
          meshOnly: { obsidian: () => canSpawn },
        }),
      });
    expect(await list(true)).toContain("obsidian.note.append");
    expect(await list(false)).not.toContain("obsidian.note.append");
  });
});
