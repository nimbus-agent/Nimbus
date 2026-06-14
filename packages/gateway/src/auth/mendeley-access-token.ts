import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidMendeleyAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.mendeley,
    vault,
    clientId: Config.oauthMendeleyClientId,
    clientSecret: Config.oauthMendeleyClientSecret,
    notConfiguredError: "Mendeley OAuth not configured; run: nimbus connector auth mendeley",
    parseErrors: {
      invalidJson: "Invalid mendeley.oauth vault payload",
      invalidPayload: "Invalid mendeley.oauth vault payload",
      missingAccess: "Missing Mendeley access token",
      missingRefresh: "Missing Mendeley refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_MENDELEY_CLIENT_ID and NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET for Mendeley token refresh",
  });
}
