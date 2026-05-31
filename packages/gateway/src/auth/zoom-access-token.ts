import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidZoomAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.zoom,
    vault,
    clientId: Config.oauthZoomClientId,
    clientSecret: Config.oauthZoomClientSecret,
    notConfiguredError: "Zoom OAuth not configured; run: nimbus connector auth zoom",
    parseErrors: {
      invalidJson: "Invalid zoom.oauth vault payload",
      invalidPayload: "Invalid zoom.oauth vault payload",
      missingAccess: "Missing Zoom access token",
      missingRefresh: "Missing Zoom refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_ZOOM_CLIENT_ID and NIMBUS_OAUTH_ZOOM_CLIENT_SECRET for Zoom token refresh",
  });
}
