import { readConnectorSecret } from "../connectors/connector-vault.ts";
import type { ChatopsBotToolRequest } from "../connectors/lazy-mesh/chatops-bot-spawn.ts";
import { spawnChatopsBotToolAndCall } from "../connectors/lazy-mesh/chatops-bot-spawn.ts";
import { createTeamVaultView } from "../teamvault/team-vault-view.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ChatPlatform } from "./types.ts";

/** Bot secrets each platform's ChatOps tools need. Composed only via `readConnectorSecret`
 *  (D11) against the team VIEW, which remaps bare connector keys to `teamvault.<entry>.<key>`.
 *  Narrower than `CONNECTOR_VAULT_SECRET_KEYS` on purpose: a bot entry holds bot credentials,
 *  not the operator's OAuth set. */
const REQUIRED_BOT_SECRETS: Readonly<
  Record<
    ChatPlatform,
    readonly { readonly label: string; readonly read: (v: NimbusVault) => Promise<string | null> }[]
  >
> = {
  slack: [
    { label: "slack bot_token", read: (v) => readConnectorSecret(v, "slack", "bot_token") },
    { label: "slack app_token", read: (v) => readConnectorSecret(v, "slack", "app_token") },
  ],
  teams: [
    { label: "teams bot_app_id", read: (v) => readConnectorSecret(v, "teams", "bot_app_id") },
    {
      label: "teams bot_app_password",
      read: (v) => readConnectorSecret(v, "teams", "bot_app_password"),
    },
  ],
};

export interface ChatopsToolRunnerDeps {
  readonly vault: NimbusVault;
  /** `[chatops].bot_vault_entry` — the Team-Vault entry holding the bot credentials. */
  readonly botVaultEntry: string;
  readonly sandboxCwd: string;
  /** Ephemeral spawn seam (default: real bot-credentialed connector spawning). */
  readonly spawnAndCall?: (req: ChatopsBotToolRequest) => Promise<unknown>;
}

export type RunChatopsTool = (
  platform: ChatPlatform,
  toolId: string,
  args: unknown,
  opts?: { readonly serviceUrl?: string },
) => Promise<unknown>;

/**
 * ChatOps connector-tool invocation (Phase 6 Slice 5 boot wiring). Mirrors the I19
 * `invokeTeamTool` pattern: resolve a read-only team-vault VIEW for the bot entry, fail CLOSED
 * when any required bot secret is missing, and hand the view to an ephemeral spawn seam — the
 * secret values never enter this function's scope and are never returned.
 */
export function buildChatopsToolRunner(deps: ChatopsToolRunnerDeps): RunChatopsTool {
  const spawnAndCall = deps.spawnAndCall ?? spawnChatopsBotToolAndCall;
  return async (platform, toolId, args, opts) => {
    const view = createTeamVaultView(deps.vault, deps.botVaultEntry);
    for (const secret of REQUIRED_BOT_SECRETS[platform]) {
      const v = await secret.read(view);
      if (v === null || v === "") {
        throw new Error(
          `chatops: missing required bot secret "${secret.label}" in team-vault entry "${deps.botVaultEntry}" (fail-closed)`,
        );
      }
    }
    return spawnAndCall({
      platform,
      toolId,
      args,
      vaultView: view,
      sandboxCwd: deps.sandboxCwd,
      ...(opts?.serviceUrl === undefined ? {} : { teams: { serviceUrl: opts.serviceUrl } }),
    });
  };
}
