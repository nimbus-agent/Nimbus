import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

/**
 * Returns a valid Zoom user access token, refreshing via the registry's
 * single-flight `getValidVaultAccessToken` when near expiry. Persists the
 * rotated refresh token Zoom issues on every refresh (the chain-invalidating
 * concern that motivated the PR-1 single-flight lock landed in PR-1; Zoom
 * invalidates the entire token chain on refresh-token reuse).
 */
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
