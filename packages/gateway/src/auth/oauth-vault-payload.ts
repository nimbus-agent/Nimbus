export type StoredOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /**
   * Per-tenant API host discovered at OAuth time (e.g. Salesforce's
   * `instance_url`). Optional and absent for every provider whose API host is a
   * fixed SaaS endpoint — included only when the stored blob carries a
   * non-empty `instanceUrl` string.
   */
  instanceUrl?: string;
};

export type ParseStoredOAuthErrors = {
  invalidJson: string;
  invalidPayload: string;
  missingAccess: string;
  missingRefresh: string;
  missingExpiry: string;
};

export function parseStoredOAuthTokens(
  raw: string,
  errs: ParseStoredOAuthErrors,
): StoredOAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError(errs.invalidJson);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(errs.invalidPayload);
  }
  const rec = parsed as Record<string, unknown>;
  const accessToken = rec["accessToken"];
  const refreshToken = rec["refreshToken"];
  const expiresAt = rec["expiresAt"];
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new TypeError(errs.missingAccess);
  }
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new TypeError(errs.missingRefresh);
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new TypeError(errs.missingExpiry);
  }
  // Optional, additive: only include `instanceUrl` when the stored blob carries
  // a non-empty string. Every pre-existing provider's blob lacks it, so its
  // parse result is byte-identical to before.
  const instanceUrl = rec["instanceUrl"];
  if (typeof instanceUrl === "string" && instanceUrl !== "") {
    return { accessToken, refreshToken, expiresAt, instanceUrl };
  }
  return { accessToken, refreshToken, expiresAt };
}
