import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidSlackAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.slack,
    vault,
    clientId: Config.oauthSlackClientId,
    notConfiguredError: "Slack OAuth not configured; run: nimbus connector auth slack",
    parseErrors: {
      invalidJson: "Invalid slack.oauth vault payload",
      invalidPayload: "Invalid slack.oauth vault payload",
      missingAccess: "Missing Slack access token",
      missingRefresh: "Missing Slack refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError: "Set NIMBUS_OAUTH_SLACK_CLIENT_ID for Slack token refresh",
  });
}
