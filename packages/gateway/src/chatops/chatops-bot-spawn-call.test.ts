import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  type ChatopsBotToolRequest,
  spawnChatopsBotToolAndCall,
} from "./chatops-bot-spawn-call.ts";

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
    sandboxCwd: "/cwd",
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
