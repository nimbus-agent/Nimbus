import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPClient } from "@mastra/mcp";
import type { ServerSpec } from "../connectors/lazy-mesh/slot.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

// The success path of `spawnChatopsBotToolAndCall` constructs a REAL `MCPClient` (no injection
// seam by design). To cover that construction + the `runBotToolCall` hand-off WITHOUT opening a
// connector subprocess, mock `@mastra/mcp` — the same canonical pattern used by
// `test/unit/connectors/lazy-mesh/connector-spawns.test.ts`. The mock captures the constructor
// args (so the spawned id can be asserted) and serves a fixed tool map through `listTools`.
const capturedClients: Array<{ id: string; servers: Record<string, ServerSpec> }> = [];

mock.module("@mastra/mcp", () => ({
  MCPClient: class MockMCPClient {
    readonly id: string;
    readonly servers: Record<string, ServerSpec>;
    constructor(args: { id: string; servers: Record<string, ServerSpec> }) {
      this.id = args.id;
      this.servers = args.servers;
      capturedClients.push({ id: args.id, servers: args.servers });
    }
    listTools(): Promise<LazyMeshToolMap> {
      return Promise.resolve({
        slack_chat_post: { execute: (a: unknown) => Promise.resolve({ posted: a }) },
        teams_chat_post: { execute: (a: unknown) => Promise.resolve({ posted: a }) },
      });
    }
    // Superset surface so this process-global mock is also safe for any sibling SUT that only
    // constructs/connects an MCPClient (mirrors the connector-spawns canonical mock).
    getTools(): Promise<Record<string, unknown>> {
      return Promise.resolve({});
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    disconnect(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import {
  type ChatopsBotToolRequest,
  runBotToolCall,
  spawnChatopsBotToolAndCall,
} from "./chatops-bot-spawn-call.ts";

// Inert in these tests (the fail-closed path returns before any spawn reads it), but built
// cross-platform per convention.
const TEST_CWD = join(tmpdir(), "nimbus-chatops-bot-spawn-test");

/**
 * The success path of `spawnChatopsBotToolAndCall` constructs a REAL `MCPClient` against a bot
 * connector subprocess (no injection seam by design — same untestable real-I/O shell as
 * `teamvault/team-tool-spawn.ts`; the spec builders it reuses are covered in chatops-bot-spawn.test
 * and the full path is proven by the ChatOps e2e). These unit tests pin the pre-spawn fail-closed
 * branch: when the bot vault VIEW is missing a required secret the matching spec builder returns
 * `undefined`, and the call throws BEFORE any subprocess is opened.
 */
function fakeVault(entries: Record<string, string>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
    set: () => Promise.reject(new Error("read-only")),
    delete: () => Promise.reject(new Error("read-only")),
    listKeys: (prefix?: string) =>
      Promise.resolve(Object.keys(entries).filter((k) => k.startsWith(prefix ?? ""))),
  };
}

function req(over: Partial<ChatopsBotToolRequest>): ChatopsBotToolRequest {
  return {
    platform: "slack",
    toolId: "slack_chat_post",
    args: {},
    vaultView: fakeVault({}),
    sandboxCwd: TEST_CWD,
    ...over,
  };
}

describe("spawnChatopsBotToolAndCall — fail-closed before any subprocess spawn", () => {
  test("slack: missing bot credentials → throws fail-closed (never opens a connector)", async () => {
    await expect(
      spawnChatopsBotToolAndCall(req({ platform: "slack", vaultView: fakeVault({}) })),
    ).rejects.toThrow(/bot credentials missing for "slack" \(fail-closed\)/);
  });

  test("slack: partial credentials (app_token only) still fail closed", async () => {
    await expect(
      spawnChatopsBotToolAndCall(
        req({ platform: "slack", vaultView: fakeVault({ "slack.app_token": "xapp-1" }) }),
      ),
    ).rejects.toThrow(/bot credentials missing for "slack"/);
  });

  test("teams: missing bot credentials → throws fail-closed (teams branch of the spec selector)", async () => {
    await expect(
      spawnChatopsBotToolAndCall(
        req({ platform: "teams", toolId: "teams_chat_post", vaultView: fakeVault({}) }),
      ),
    ).rejects.toThrow(/bot credentials missing for "teams" \(fail-closed\)/);
  });

  test("teams: the per-activity serviceUrl opts flow through to the teams spec builder", async () => {
    // Even with serviceUrl threaded, absent teams credentials → fail-closed (the opts path is
    // exercised by the teams branch before the undefined-servers guard).
    await expect(
      spawnChatopsBotToolAndCall(
        req({
          platform: "teams",
          toolId: "teams_chat_post",
          vaultView: fakeVault({}),
          teams: { serviceUrl: "https://smba.example/emea/" },
        }),
      ),
    ).rejects.toThrow(/fail-closed/);
  });
});

function fakeClient(
  tools: LazyMeshToolMap,
  onDisconnect: () => Promise<void> = () => Promise.resolve(),
): MCPClient {
  return {
    listTools: () => Promise.resolve(tools),
    disconnect: onDisconnect,
  } as unknown as MCPClient;
}

describe("runBotToolCall — post-spawn tool dispatch (fake client, no subprocess)", () => {
  test("calls the tool by its exact id and returns the result", async () => {
    const client = fakeClient({
      slack_chat_post: { execute: (a) => Promise.resolve({ posted: a }) },
    });
    expect(await runBotToolCall(client, "slack", "slack_chat_post", { text: "hi" })).toEqual({
      posted: { text: "hi" },
    });
  });

  test("falls back to the platform-prefixed tool id", async () => {
    const client = fakeClient({ slack_chat_post: { execute: () => Promise.resolve("ok") } });
    // caller passes the bare id; lookup falls back to `${platform}_${toolId}`
    expect(await runBotToolCall(client, "slack", "chat_post", {})).toBe("ok");
  });

  test("throws not-found when neither the id nor the prefixed id resolves to an executable tool", async () => {
    const client = fakeClient({ unrelated: { execute: () => Promise.resolve(1) } });
    await expect(runBotToolCall(client, "teams", "teams_chat_post", {})).rejects.toThrow(
      /tool "teams_chat_post" not found for platform "teams"/,
    );
  });

  test("throws not-found when the matched tool has no execute", async () => {
    const client = fakeClient({ slack_chat_post: {} });
    await expect(runBotToolCall(client, "slack", "slack_chat_post", {})).rejects.toThrow(
      /tool "slack_chat_post" not found for platform "slack"/,
    );
  });

  test("disconnects in finally, swallowing disconnect errors", async () => {
    let disconnected = 0;
    const client = fakeClient(
      { slack_chat_post: { execute: () => Promise.resolve("done") } },
      () => {
        disconnected += 1;
        return Promise.reject(new Error("disconnect boom"));
      },
    );
    expect(await runBotToolCall(client, "slack", "slack_chat_post", {})).toBe("done");
    expect(disconnected).toBe(1);
  });
});

describe("spawnChatopsBotToolAndCall — success path (mocked MCPClient, no subprocess)", () => {
  test("slack: with bot credentials present, constructs the client and dispatches the tool", async () => {
    capturedClients.length = 0;
    const result = await spawnChatopsBotToolAndCall(
      req({
        platform: "slack",
        toolId: "slack_chat_post",
        args: { text: "hello" },
        vaultView: fakeVault({ "slack.bot_token": "xoxb-1", "slack.app_token": "xapp-1" }),
      }),
    );
    // The dispatch returned the mocked tool's result → lines 67 (new MCPClient) + 68
    // (return runBotToolCall(...)) both executed.
    expect(result).toEqual({ posted: { text: "hello" } });
    // The constructed client id is the platform-scoped, per-spawn nimbus id.
    expect(capturedClients).toHaveLength(1);
    const captured = capturedClients[0];
    expect(captured?.id).toMatch(/^nimbus-chatops-slack-/);
    expect(captured?.servers).toHaveProperty("slack");
  });

  test("teams: with bot credentials present (graph-token seam), constructs the client and dispatches", async () => {
    capturedClients.length = 0;
    const result = await spawnChatopsBotToolAndCall(
      req({
        platform: "teams",
        toolId: "teams_chat_post",
        args: { text: "hi-teams" },
        vaultView: fakeVault({
          "teams.bot_app_id": "app-id-1",
          "teams.bot_app_password": "app-pw-1",
        }),
        // Inject the graph-token resolver so the real Microsoft OAuth machinery is never touched.
        teams: { graphTokenResolver: () => Promise.resolve("") },
      }),
    );
    expect(result).toEqual({ posted: { text: "hi-teams" } });
    expect(capturedClients).toHaveLength(1);
    expect(capturedClients[0]?.id).toMatch(/^nimbus-chatops-teams-/);
    expect(capturedClients[0]?.servers).toHaveProperty("teams");
  });
});
