import { Config } from "../config.ts";
import { perServiceOAuthVaultKey } from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { MICROSOFT_OAUTH_CLIENT_ID_HELP } from "./oauth-env-help-messages.ts";
import { getValidVaultAccessToken } from "./oauth-registry.ts";
import type { ParseStoredOAuthErrors } from "./oauth-vault-payload.ts";
import { resolveOAuthDescriptor } from "./workday-oauth-descriptor.ts";

export {
  type ParseStoredOAuthErrors,
  parseStoredOAuthTokens,
  type StoredOAuthTokens,
} from "./oauth-vault-payload.ts";

export async function getValidVaultOAuthAccessToken(args: {
  vault: NimbusVault;
  vaultKey: string;
  notConfiguredError: string;
  parseErrors: ParseStoredOAuthErrors;
  marginMs?: number;
  getClientId: () => string;
  emptyClientIdError: string;
  provider: "google" | "microsoft";
}): Promise<string> {
  const clientSecret =
    args.provider === "google" && Config.oauthGoogleClientSecret !== ""
      ? Config.oauthGoogleClientSecret
      : undefined;
  return getValidVaultAccessToken({
    descriptor: resolveOAuthDescriptor(args.provider),
    vault: args.vault,
    vaultKey: args.vaultKey,
    clientId: args.getClientId(),
    ...(clientSecret !== undefined && { clientSecret }),
    notConfiguredError: args.notConfiguredError,
    parseErrors: args.parseErrors,
    emptyClientIdError: args.emptyClientIdError,
  });
}

export function microsoftOAuthAccessFromConfig(): {
  vaultKey: string;
  notConfiguredError: string;
  parseErrors: ParseStoredOAuthErrors;
  getClientId: () => string;
  emptyClientIdError: string;
  provider: "microsoft";
} {
  return {
    vaultKey: "microsoft.oauth",
    notConfiguredError:
      "Microsoft OAuth not configured; run: nimbus connector auth onedrive (or outlook / teams)",
    parseErrors: {
      invalidJson: "Invalid microsoft.oauth vault payload",
      invalidPayload: "Invalid microsoft.oauth vault payload",
      missingAccess: "Missing Microsoft access token",
      missingRefresh: "Missing Microsoft refresh token",
      missingExpiry: "Missing token expiry",
    },
    getClientId: () => Config.oauthMicrosoftClientId,
    emptyClientIdError: MICROSOFT_OAUTH_CLIENT_ID_HELP,
    provider: "microsoft",
  };
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Space-separated Graph delegated scopes from `microsoft.oauth` for `MICROSOFT_OAUTH_SCOPES`
 * (Outlook MCP registers only tools satisfied by these scopes). Returns `undefined` when
 * the vault payload has no non-empty `scopes` array — Outlook keeps full tool surface.
 */
export async function readMicrosoftOAuthScopesForOutlookEnv(
  vault: NimbusVault,
): Promise<string | undefined> {
  return oauthScopesFromVaultPayload(await vault.get("microsoft.oauth"));
}

/**
 * Space-separated scopes of the credential Gmail would use (its own key, else the shared
 * `google.oauth` one, the order `resolveGoogleOAuthVaultKey` uses), for the Gmail child's
 * `GOOGLE_OAUTH_SCOPES`: the connector lists a scope-gated tool (`gmail_thread_archive`, which
 * needs `gmail.modify`) only when its token holds the scope. `undefined` when there is no
 * credential or it records no scopes, and the connector then hides every scope-gated tool. Passed
 * to the Gmail child only, never Drive, Photos or Meet.
 */
export async function readGoogleOAuthScopesForGmailEnv(
  vault: NimbusVault,
): Promise<string | undefined> {
  const own = perServiceOAuthVaultKey("gmail");
  for (const key of own === undefined ? ["google.oauth"] : [own, "google.oauth"]) {
    const raw = await vault.get(key);
    if (raw !== null && raw !== "") {
      return oauthScopesFromVaultPayload(raw);
    }
  }
  return undefined;
}

/**
 * Space-separated scopes of Google Calendar's OWN credential (`google_calendar.oauth`), for the
 * Calendar child's `GOOGLE_OAUTH_SCOPES`: the connector lists the event writes (connectors 0.20.0)
 * only when the token holds `calendar` or `calendar.events`. Never the shared `google.oauth`: the
 * service is own-key-only (`GOOGLE_OWN_KEY_ONLY_SERVICES`), so its token never comes from that
 * key, and another consent's scopes must not unlock writes for it. `undefined` when the own key is
 * absent or records no scopes, and the connector then hides the writes (fail closed).
 */
export async function readGoogleOAuthScopesForCalendarEnv(
  vault: NimbusVault,
): Promise<string | undefined> {
  const own = perServiceOAuthVaultKey("google_calendar");
  if (own === undefined) return undefined;
  return oauthScopesFromVaultPayload(await vault.get(own));
}

/**
 * The `GOOGLE_OAUTH_SCOPES` a Google bundle child is spawned with: Gmail's and Google Calendar's
 * credential scopes (each connector lists its scope-gated tools only when the token holds the
 * scope), and `undefined` for every other Google service, which gets the access token only.
 */
export async function readGoogleOAuthScopesForSpawnEnv(
  vault: NimbusVault,
  serviceId: string,
): Promise<string | undefined> {
  if (serviceId === "gmail") return readGoogleOAuthScopesForGmailEnv(vault);
  if (serviceId === "google_calendar") return readGoogleOAuthScopesForCalendarEnv(vault);
  return undefined;
}

/**
 * The space-separated `scopes` of a stored OAuth vault payload, or `undefined` when the payload is
 * absent, not a JSON object, or has no non-empty `scopes` array. Shared by the Outlook, Gmail and
 * Google Calendar scope reads so they cannot parse a payload differently.
 */
export function oauthScopesFromVaultPayload(raw: string | null): string | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const scopes = (parsed as Record<string, unknown>)["scopes"];
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return undefined;
  }
  const strings = scopes.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (strings.length === 0) {
    return undefined;
  }
  return strings.join(" ");
}
