import { Config } from "../config.ts";
import {
  ALL_GOOGLE_OAUTH_VAULT_KEYS,
  perServiceOAuthVaultKey,
} from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { GOOGLE_OAUTH_PARSE_ERRORS } from "./google-oauth-parse-errors.ts";
import { GOOGLE_OAUTH_CLIENT_ID_HELP } from "./oauth-env-help-messages.ts";
import { getValidVaultOAuthAccessToken } from "./oauth-vault-tokens.ts";

export type GoogleConnectorOAuthServiceId =
  | "google_drive"
  | "gmail"
  | "google_photos"
  | "google_meet"
  | "google_calendar";

export { GOOGLE_OAUTH_PARSE_ERRORS } from "./google-oauth-parse-errors.ts";

/**
 * Services that resolve ONLY their own per-service key, never the shared legacy `google.oauth`.
 *
 * The shared key holds whatever the LAST Google consent produced, so a user who connected only
 * Gmail has it (with Gmail's scopes). Falling back to it for Calendar would make the sync read
 * "configured", append a `sync` egress row (I29) every run and send a Gmail token to the Calendar
 * API (403 each time): calendar access the owner never granted. Calendar's own consent
 * (`nimbus connector auth google_calendar`) is the only way in. The siblings keep their fallback.
 * One constant, read by the resolver, so the token lookup, `isConnectorConfigured` and the mesh
 * bundle agree by construction.
 */
export const GOOGLE_OWN_KEY_ONLY_SERVICES: ReadonlySet<GoogleConnectorOAuthServiceId> = new Set([
  "google_calendar",
]);

const NOT_CONFIGURED =
  "Google OAuth not configured; run: nimbus connector auth google_drive (or gmail / google_photos / google_meet / google_calendar)";

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
  if (GOOGLE_OWN_KEY_ONLY_SERVICES.has(serviceId)) {
    return null;
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
