import { Config } from "../config.ts";
import {
  ALL_GOOGLE_OAUTH_VAULT_KEYS,
  perServiceOAuthVaultKey,
} from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { GOOGLE_OAUTH_CLIENT_ID_HELP } from "./oauth-env-help-messages.ts";
import {
  getValidVaultOAuthAccessToken,
  type ParseStoredOAuthErrors,
} from "./oauth-vault-tokens.ts";

export type GoogleConnectorOAuthServiceId =
  | "google_drive"
  | "gmail"
  | "google_photos"
  | "google_meet";

export const GOOGLE_OAUTH_PARSE_ERRORS: ParseStoredOAuthErrors = {
  invalidJson: "Invalid Google OAuth vault payload",
  invalidPayload: "Invalid Google OAuth vault payload",
  missingAccess: "Missing Google access token",
  missingRefresh: "Missing Google refresh token",
  missingExpiry: "Missing token expiry",
};

const NOT_CONFIGURED =
  "Google OAuth not configured; run: nimbus connector auth google_drive (or gmail / google_photos / google_meet)";

export async function anyGoogleOAuthVaultPresent(vault: NimbusVault): Promise<boolean> {
  for (const k of ALL_GOOGLE_OAUTH_VAULT_KEYS) {
    const v = await vault.get(k);
    if (v !== null && v !== "") {
      return true;
    }
  }
  return false;
}

export async function resolveGoogleOAuthVaultKey(
  vault: NimbusVault,
  serviceId: GoogleConnectorOAuthServiceId,
): Promise<string | null> {
  const preferred = perServiceOAuthVaultKey(serviceId);
  if (preferred !== undefined) {
    const raw = await vault.get(preferred);
    if (raw !== null && raw !== "") {
      return preferred;
    }
  }
  const shared = await vault.get("google.oauth");
  if (shared !== null && shared !== "") {
    return "google.oauth";
  }
  return null;
}

export async function getValidGoogleAccessToken(
  vault: NimbusVault,
  serviceId: GoogleConnectorOAuthServiceId,
): Promise<string> {
  const vaultKey = await resolveGoogleOAuthVaultKey(vault, serviceId);
  if (vaultKey === null) {
    throw new Error(NOT_CONFIGURED);
  }
  return getValidVaultOAuthAccessToken({
    vault,
    vaultKey,
    notConfiguredError: NOT_CONFIGURED,
    parseErrors: GOOGLE_OAUTH_PARSE_ERRORS,
    getClientId: () => Config.oauthGoogleClientId,
    emptyClientIdError: GOOGLE_OAUTH_CLIENT_ID_HELP,
    provider: "google",
  });
}
