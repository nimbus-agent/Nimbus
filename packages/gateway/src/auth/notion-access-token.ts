import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidNotionAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.notion,
    vault,
    clientId: Config.oauthNotionClientId,
    clientSecret: Config.oauthNotionClientSecret,
    notConfiguredError: "Notion OAuth not configured; run: nimbus connector auth notion",
    parseErrors: {
      invalidJson: "Invalid notion.oauth vault payload",
      invalidPayload: "Invalid notion.oauth vault payload",
      missingAccess: "Missing Notion access token",
      missingRefresh: "Missing Notion refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_NOTION_CLIENT_ID and NIMBUS_OAUTH_NOTION_CLIENT_SECRET for Notion token refresh",
  });
}
