import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import { getValidMicrosoftAccessToken } from "../../auth/microsoft-access-token.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { mcpConnectorServerScript } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";
import { listLazyMeshClientTools } from "./tool-map.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

/**
 * ChatOps bot-credentialed connector spawning — Phase 6 Slice 5 boot wiring.
 *
 * The regular lazy-mesh spawners inject the OPERATOR's OAuth tokens; the ChatOps bot tools
 * (`slack_user_info` / `slack_chat_post` / `slack_socket_open` / `teams_user_info` /
 * `teams_chat_post`) instead need the TEAM bot credentials (Team-Vault keys `slack.bot_token` /
 * `slack.app_token` / `teams.bot_app_id` / `teams.bot_app_password`) injected as env. These
 * builders read those keys from the caller-supplied vault VIEW (the chatops team-vault view —
 * I19 pattern: the secret only ever lives in the view's call scope + the subprocess env) and
 * produce sandbox-wrapped specs through the same `extensionProcessEnv` (I1) + `wrapServerSpec`
 * (I15) pipeline as every other lazy-mesh spawn.
 */

export interface ChatopsTeamsSpawnOpts {
  /** Bot Framework serviceUrl from the inbound activity (per-conversation reply endpoint). */
  readonly serviceUrl?: string;
}

/** Slack bot spec: requires BOTH `slack.bot_token` (user_info/chat_post) and `slack.app_token`
 *  (socket_open). Missing either → undefined (fail-closed: no spawn, never a partial bot). */
export async function chatopsSlackBotServers(
  vault: NimbusVault,
  sandboxCwd: string,
): Promise<Record<string, ServerSpec> | undefined> {
  const botToken = await readConnectorSecret(vault, "slack", "bot_token");
  const appToken = await readConnectorSecret(vault, "slack", "app_token");
  if (botToken === null || botToken === "" || appToken === null || appToken === "") {
    return undefined;
  }
  return {
    slack: wrapServerSpec(
      {
        command: "bun",
        args: [mcpConnectorServerScript("slack")],
        env: extensionProcessEnv({ SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken }),
      },
      manifestForFirstParty("slack"),
      sandboxCwd,
    ),
  };
}

/** Teams bot spec: requires `teams.bot_app_id` + `teams.bot_app_password`. `MICROSOFT_OAUTH_ACCESS_TOKEN`
 *  (for `teams_user_info` Graph lookups) is added only when the bot vault entry also carries a
 *  `microsoft.oauth` credential; otherwise the lookup tool fails closed in the connector. */
export async function chatopsTeamsBotServers(
  vault: NimbusVault,
  sandboxCwd: string,
  opts?: ChatopsTeamsSpawnOpts,
): Promise<Record<string, ServerSpec> | undefined> {
  const appId = await readConnectorSecret(vault, "teams", "bot_app_id");
  const appPassword = await readConnectorSecret(vault, "teams", "bot_app_password");
  if (appId === null || appId === "" || appPassword === null || appPassword === "") {
    return undefined;
  }
  let graphToken: string | undefined;
  try {
    const t = await getValidMicrosoftAccessToken(vault);
    if (t !== "") graphToken = t;
  } catch {
    graphToken = undefined; // identity mapping degrades to unmapped (fail-closed downstream)
  }
  return {
    teams: wrapServerSpec(
      {
        command: "bun",
        args: [mcpConnectorServerScript("teams")],
        env: extensionProcessEnv({
          TEAMS_BOT_APP_ID: appId,
          TEAMS_BOT_APP_PASSWORD: appPassword,
          ...(opts?.serviceUrl === undefined ? {} : { TEAMS_BOT_SERVICE_URL: opts.serviceUrl }),
          ...(graphToken === undefined ? {} : { MICROSOFT_OAUTH_ACCESS_TOKEN: graphToken }),
        }),
      },
      manifestForFirstParty("teams"),
      sandboxCwd,
    ),
  };
}

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
 * Ephemeral bot-credentialed spawn-and-call (mirrors `team-tool-spawn.ts`): spawn a throwaway
 * connector with the bot env, call the named tool, tear the instance down. The bot secret only
 * ever lives in the subprocess env — never returned to the caller.
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
  try {
    const tools = await listLazyMeshClientTools(client);
    const tool = tools[req.toolId] ?? tools[`${req.platform}_${req.toolId}`];
    if (tool?.execute === undefined) {
      throw new Error(`chatops: tool "${req.toolId}" not found for platform "${req.platform}"`);
    }
    return await tool.execute(req.args);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
