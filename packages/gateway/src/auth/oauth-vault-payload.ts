export type StoredOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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
  return { accessToken, refreshToken, expiresAt };
}
