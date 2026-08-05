import { getValidMicrosoftAccessToken } from "../../auth/microsoft-access-token.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";
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
  /** Test seam for the best-effort Graph-token resolve (default: `getValidMicrosoftAccessToken`).
   *  Keeps the real OAuth/refresh machinery out of this builder's unit tests. */
  readonly graphTokenResolver?: (vault: NimbusVault) => Promise<string>;
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
        ...connectorSpawn("slack"),
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
    const resolveGraphToken = opts?.graphTokenResolver ?? getValidMicrosoftAccessToken;
    const t = await resolveGraphToken(vault);
    if (t !== "") graphToken = t;
  } catch {
    graphToken = undefined; // identity mapping degrades to unmapped (fail-closed downstream)
  }
  return {
    teams: wrapServerSpec(
      {
        ...connectorSpawn("teams"),
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
