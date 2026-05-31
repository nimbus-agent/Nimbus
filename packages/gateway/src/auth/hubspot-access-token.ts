import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidHubspotAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.hubspot,
    vault,
    clientId: Config.oauthHubspotClientId,
    clientSecret: Config.oauthHubspotClientSecret,
    notConfiguredError: "HubSpot OAuth not configured; run: nimbus connector auth hubspot",
    parseErrors: {
      invalidJson: "Invalid hubspot.oauth vault payload",
      invalidPayload: "Invalid hubspot.oauth vault payload",
      missingAccess: "Missing HubSpot access token",
      missingRefresh: "Missing HubSpot refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_HUBSPOT_CLIENT_ID and NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET for HubSpot token refresh",
  });
}
