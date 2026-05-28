import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { MICROSOFT_OAUTH_CLIENT_ID_HELP } from "./oauth-env-help-messages.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";

// Re-exported from `oauth-vault-payload.ts` to preserve the existing import
// surface (google-access-token.ts + oauth-vault-tokens.test.ts) while keeping
// the runtime parser available to `oauth-registry.ts` without a cycle.
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
    descriptor: OAUTH_PROVIDERS[args.provider],
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
  const raw = await vault.get("microsoft.oauth");
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
