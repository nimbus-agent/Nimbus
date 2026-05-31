import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidMiroAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.miro,
    vault,
    clientId: Config.oauthMiroClientId,
    clientSecret: Config.oauthMiroClientSecret,
    notConfiguredError: "Miro OAuth not configured; run: nimbus connector auth miro",
    parseErrors: {
      invalidJson: "Invalid miro.oauth vault payload",
      invalidPayload: "Invalid miro.oauth vault payload",
      missingAccess: "Missing Miro access token",
      missingRefresh: "Missing Miro refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_MIRO_CLIENT_ID and NIMBUS_OAUTH_MIRO_CLIENT_SECRET for Miro token refresh",
  });
}
