import { Config } from "../config.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken, OAUTH_PROVIDERS } from "./oauth-registry.ts";
import { parseStoredOAuthTokens } from "./oauth-vault-payload.ts";

export interface SalesforceAuth {
  readonly accessToken: string;
  /** Per-tenant API host (e.g. https://acme.my.salesforce.com), trailing slashes stripped. */
  readonly instanceUrl: string;
}

/**
 * Resolve a valid Salesforce access token AND the per-tenant instance_url.
 *
 * `getValidVaultAccessToken` resolves (and, when near expiry, refreshes +
 * re-persists) the access token, so the `salesforce.oauth` blob is fresh by the
 * time we read it back to extract the instance_url. The instance_url is
 * required — there is no silent fallback; a missing one means re-authorization.
 */
export async function getValidSalesforceAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: OAUTH_PROVIDERS.salesforce,
    vault,
    clientId: Config.oauthSalesforceClientId,
    // exactOptionalPropertyTypes: omit the key entirely when no secret is set,
    // rather than passing an explicit undefined to the optional clientSecret.
    ...(Config.oauthSalesforceClientSecret === ""
      ? {}
      : { clientSecret: Config.oauthSalesforceClientSecret }),
    notConfiguredError: "Salesforce OAuth not configured; run: nimbus connector auth salesforce",
    parseErrors: {
      invalidJson: "Invalid salesforce.oauth vault payload",
      invalidPayload: "Invalid salesforce.oauth vault payload",
      missingAccess: "Missing Salesforce access token",
      missingRefresh: "Missing Salesforce refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_SALESFORCE_CLIENT_ID and NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET for Salesforce token refresh",
  });
}

/**
 * Salesforce needs TWO values from one OAuth exchange: the token and the per-tenant instance URL.
 * That is why it does not fit the `accessToken(): Promise<string>` capability on its own, and why
 * it takes the two capability pieces rather than a vault handle — the token from the registry, the
 * stored payload from the connector's own scoped `getSecret`.
 */
export async function getValidSalesforceAuth(
  accessTokenFor: () => Promise<string>,
  rawOAuthPayload: () => Promise<string | null>,
): Promise<SalesforceAuth> {
  const accessToken = await accessTokenFor();
  const raw = await rawOAuthPayload();
  if (raw === null || raw === "") {
    throw new Error("Salesforce OAuth not configured; run: nimbus connector auth salesforce");
  }
  const parsed = parseStoredOAuthTokens(raw, {
    invalidJson: "Invalid salesforce.oauth vault payload",
    invalidPayload: "Invalid salesforce.oauth vault payload",
    missingAccess: "Missing Salesforce access token",
    missingRefresh: "Missing Salesforce refresh token",
    missingExpiry: "Missing token expiry",
  });
  if (parsed.instanceUrl === undefined || parsed.instanceUrl === "") {
    throw new Error("Salesforce instance_url missing from stored token; re-authorize");
  }
  return { accessToken, instanceUrl: stripTrailingSlashes(parsed.instanceUrl) };
}
