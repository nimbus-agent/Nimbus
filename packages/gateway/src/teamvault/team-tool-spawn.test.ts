import { describe, expect, test } from "bun:test";
import type { MCPClient } from "@mastra/mcp";

import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";
import { runSpawnedToolCall, spawnerFor } from "./team-tool-spawn.ts";

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
    sandboxCwd: "/cwd",
    ...over,
  };
}

/** A fake MCPClient exposing only the surface runSpawnedToolCall touches: listTools + disconnect. */
function fakeClient(
  tools: LazyMeshToolMap,
  onDisconnect: () => Promise<void> = () => Promise.resolve(),
): MCPClient {
  return {
    listTools: () => Promise.resolve(tools),
    disconnect: onDisconnect,
  } as unknown as MCPClient;
}

/** A fake spawner that populates the ctx clients map (mirrors what a real spawner does). */
function spawnerWith(...clients: ReadonlyArray<readonly [string, MCPClient]>) {
  return async (ctx: MeshSpawnContext): Promise<void> => {
    for (const [key, client] of clients) ctx.setLazyClient(key, client);
  };
}

describe("spawnerFor", () => {
  test("returns the single-service spawner for a known service", () => {
    expect(spawnerFor("github")).toBe(spawners.ensureGithubMcp);
    expect(spawnerFor("slack")).toBe(spawners.ensureSlackMcp);
  });

  test("falls back to the phase-3 bundle spawner for any other service", () => {
    expect(spawnerFor("aws")).toBe(spawners.ensurePhase3BundleMcp);
    expect(spawnerFor("totally-unknown")).toBe(spawners.ensurePhase3BundleMcp);
  });
});

describe("runSpawnedToolCall", () => {
  test("calls the requested tool and returns its result", async () => {
    const client = fakeClient({ list_issues: { execute: (a) => Promise.resolve({ got: a }) } });
    const result = await runSpawnedToolCall(spawnerWith(["github", client]), req());
    expect(result).toEqual({ got: { a: 1 } });
  });

  test("searches across multiple clients and returns from the one that has the tool", async () => {
    const noMatch = fakeClient({ other_tool: { execute: () => Promise.resolve("nope") } });
    const match = fakeClient({ list_issues: { execute: () => Promise.resolve("yes") } });
    const result = await runSpawnedToolCall(spawnerWith(["a", noMatch], ["b", match]), req());
    expect(result).toBe("yes");
  });

  test("skips a tool whose execute is undefined and throws not-found", async () => {
    const client = fakeClient({ list_issues: {} }); // present but no execute
    await expect(runSpawnedToolCall(spawnerWith(["github", client]), req())).rejects.toThrow(
      /tool "list_issues" not found for service "github"/,
    );
  });

  test("throws not-found when no client exposes the tool", async () => {
    const client = fakeClient({ unrelated: { execute: () => Promise.resolve(1) } });
    await expect(runSpawnedToolCall(spawnerWith(["github", client]), req())).rejects.toThrow(
      /not found for service "github"/,
    );
  });

  test("disconnects every client in finally, swallowing disconnect errors", async () => {
    let disconnected = 0;
    const client = fakeClient({ list_issues: { execute: () => Promise.resolve("ok") } }, () => {
      disconnected += 1;
      return Promise.reject(new Error("disconnect boom"));
    });
    const result = await runSpawnedToolCall(spawnerWith(["github", client]), req());
    expect(result).toBe("ok");
    expect(disconnected).toBe(1); // rejection swallowed, no throw
  });

  test("disconnects partially-registered clients if the spawner throws mid-registration", async () => {
    let disconnected = 0;
    const partial = fakeClient({}, () => {
      disconnected += 1;
      return Promise.resolve();
    });
    const spawner = async (ctx: MeshSpawnContext): Promise<void> => {
      ctx.setLazyClient("partial", partial);
      throw new Error("spawn boom");
    };
    // The spawner error propagates, but the already-registered client is still disconnected.
    await expect(runSpawnedToolCall(spawner, req())).rejects.toThrow("spawn boom");
    expect(disconnected).toBe(1);
  });
});
