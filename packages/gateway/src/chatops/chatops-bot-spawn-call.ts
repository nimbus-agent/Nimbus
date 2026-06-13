import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import {
  type ChatopsTeamsSpawnOpts,
  chatopsSlackBotServers,
  chatopsTeamsBotServers,
} from "../connectors/lazy-mesh/chatops-bot-spawn.ts";
import { listLazyMeshClientTools } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ChatopsBotToolRequest {
  readonly platform: "slack" | "teams";
  readonly toolId: string;
  readonly args: unknown;
  /** The chatops team-vault view (bare keys remapped to `teamvault.<entry>.*`). */
  readonly vaultView: NimbusVault;
  readonly sandboxCwd: string;
  readonly teams?: ChatopsTeamsSpawnOpts;
}

/**
 * The testable post-spawn dispatch of {@link spawnChatopsBotToolAndCall}: look up the tool (by id,
 * then platform-prefixed id), execute it, and disconnect in `finally`. Extracted so the dispatch
 * logic is unit-testable with a fake MCPClient, without opening a real bot connector subprocess.
 */
export async function runBotToolCall(
  client: MCPClient,
  platform: "slack" | "teams",
  toolId: string,
  args: unknown,
): Promise<unknown> {
  try {
    const tools = await listLazyMeshClientTools(client);
    const tool = tools[toolId] ?? tools[`${platform}_${toolId}`];
    if (tool?.execute === undefined) {
      throw new Error(`chatops: tool "${toolId}" not found for platform "${platform}"`);
    }
    return await tool.execute(args);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Ephemeral bot-credentialed spawn-and-call (mirrors `teamvault/team-tool-spawn.ts`): spawn a
 * throwaway connector with the bot env, call the named tool, tear the instance down. The bot
 * secret only ever lives in the spawned subprocess env — never returned to the caller.
 *
 * This is the same untestable real-subprocess I/O shell as `spawnTeamToolAndCall`: it constructs
 * `new MCPClient(...)` and opens a real connector subprocess with no injection seam. It lives under
 * `chatops/` (not `lazy-mesh/`) for the same reason `teamvault/team-tool-spawn.ts` does — it only
 * REUSES the lazy-mesh sandbox-wrapped spec builders (`chatopsSlackBotServers` /
 * `chatopsTeamsBotServers` in `chatops-bot-spawn.ts`, the I15 `wrapServerSpec` site), it does not
 * author a new `ServerSpec`. Those builders ARE covered; this glue is exercised end-to-end by the
 * ChatOps e2e + chatops-bot-spawn.test.ts.
 */
export async function spawnChatopsBotToolAndCall(req: ChatopsBotToolRequest): Promise<unknown> {
  const servers =
    req.platform === "slack"
      ? await chatopsSlackBotServers(req.vaultView, req.sandboxCwd)
      : await chatopsTeamsBotServers(req.vaultView, req.sandboxCwd, req.teams);
  if (servers === undefined) {
    throw new Error(`chatops: bot credentials missing for "${req.platform}" (fail-closed)`);
  }
  const client = new MCPClient({ id: `nimbus-chatops-${req.platform}-${randomUUID()}`, servers });
  return runBotToolCall(client, req.platform, req.toolId, req.args);
}
