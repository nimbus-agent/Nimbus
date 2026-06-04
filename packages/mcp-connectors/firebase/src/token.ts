import { type GoogleServiceAccount, parseServiceAccountJson } from "@nimbus-dev/sdk";

/**
 * Firebase App Distribution credential plumbing.
 *
 * The OAuth2 token-mint flow (RS256 JWT-bearer) lives in `@nimbus-dev/sdk`
 * (`mintGoogleAccessToken`) so the gateway sync and this MCP server share one
 * signer across the package boundary. This module holds only the connector's
 * env-specific glue: reading the spawn-injected credentials and deriving the
 * project number from a Firebase app id.
 */

/** The project number is the 2nd colon-segment of a Firebase app id. */
export function projectNumberFromAppId(appId: string): string | null {
  const segment = appId.split(":")[1];
  return segment !== undefined && segment !== "" ? segment : null;
}

/**
 * Parse the injected `FIREBASE_SERVICE_ACCOUNT_JSON` env into a service account;
 * throws if unset or malformed. The Gateway sets this at spawn time.
 */
export function serviceAccountFromEnv(): GoogleServiceAccount {
  const json = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"]?.trim();
  if (json === undefined || json === "") {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  }
  const sa = parseServiceAccountJson(json);
  if (sa === null) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service-account key");
  }
  return sa;
}

/** Parse the injected comma-separated `FIREBASE_APP_IDS` env into a list. */
export function configuredAppIds(): string[] {
  return (process.env["FIREBASE_APP_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
