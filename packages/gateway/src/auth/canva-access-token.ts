import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidCanvaAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.canva,
    vault,
    clientId: Config.oauthCanvaClientId,
    clientSecret: Config.oauthCanvaClientSecret,
    notConfiguredError: "Canva OAuth not configured; run: nimbus connector auth canva",
    parseErrors: {
      invalidJson: "Invalid canva.oauth vault payload",
      invalidPayload: "Invalid canva.oauth vault payload",
      missingAccess: "Missing Canva access token",
      missingRefresh: "Missing Canva refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_CANVA_CLIENT_ID and NIMBUS_OAUTH_CANVA_CLIENT_SECRET for Canva token refresh",
  });
}
