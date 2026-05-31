import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

export async function getValidFigmaAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.figma,
    vault,
    clientId: Config.oauthFigmaClientId,
    clientSecret: Config.oauthFigmaClientSecret,
    notConfiguredError: "Figma OAuth not configured; run: nimbus connector auth figma",
    parseErrors: {
      invalidJson: "Invalid figma.oauth vault payload",
      invalidPayload: "Invalid figma.oauth vault payload",
      missingAccess: "Missing Figma access token",
      missingRefresh: "Missing Figma refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_FIGMA_CLIENT_ID and NIMBUS_OAUTH_FIGMA_CLIENT_SECRET for Figma token refresh",
  });
}
