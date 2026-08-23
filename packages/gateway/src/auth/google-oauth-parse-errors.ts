import type { ParseStoredOAuthErrors } from "./oauth-vault-payload.ts";

/**
 * The five messages `parseStoredOAuthTokens` throws for a stored Google credential it cannot
 * read, in their own module rather than in `google-access-token.ts`.
 *
 * They are a shared SSoT, not a private detail: `getValidGoogleAccessToken` throws them, and
 * `classifyGoogleCredentialFailure` in `connectors/lazy-mesh/connector-spawns.ts` matches
 * against them to decide whether a credential failed at PARSE time or at REFRESH time.
 *
 * The split exists because `google-access-token.ts` is `mock.module`d — process-globally, by
 * two different test files — and a consumer that reads a constant out of a mocked module is
 * reading whatever the last mock factory happened to include. This module is mocked by nobody,
 * so the classifier and any test agree on the strings whatever else is faked.
 */
export const GOOGLE_OAUTH_PARSE_ERRORS: ParseStoredOAuthErrors = {
  invalidJson: "Invalid Google OAuth vault payload",
  invalidPayload: "Invalid Google OAuth vault payload",
  missingAccess: "Missing Google access token",
  missingRefresh: "Missing Google refresh token",
  missingExpiry: "Missing token expiry",
};
