import crypto from "node:crypto";

/**
 * Firebase App Distribution authentication (connector-local copy).
 *
 * The gateway sync and this MCP server cannot share code, so this mirrors the
 * gateway-side `firebase-token.ts`: App Distribution's REST API is a Google
 * Cloud API that accepts a short-lived OAuth2 access token in the
 * `Authorization: Bearer` header. We mint that token from a Google **service
 * account** key (the JSON the developer downloads) using the JWT-bearer grant —
 * no `googleapis` dependency.
 *
 * See: https://developers.google.com/identity/protocols/oauth2/service-account
 */

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Google caps SA assertion lifetime at 1 hour. */
const ASSERTION_TTL_SECONDS = 3600;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface FirebaseServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a service-account key JSON string into the three fields we need.
 * Returns null on malformed JSON or a missing `client_email` / `private_key`.
 */
export function parseServiceAccountJson(json: string): FirebaseServiceAccount | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const clientEmail = asString(obj["client_email"]);
  const privateKey = asString(obj["private_key"]);
  if (clientEmail === undefined || privateKey === undefined) {
    return null;
  }
  return {
    clientEmail,
    privateKey,
    tokenUri: asString(obj["token_uri"]) ?? DEFAULT_TOKEN_URI,
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Sign an RS256 JWT assertion for the JWT-bearer grant.
 *
 * `nowMs` is injectable so tests can assert deterministic `iat`/`exp` claims.
 */
export function signServiceAccountAssertion(
  sa: FirebaseServiceAccount,
  nowMs: number = Date.now(),
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.clientEmail,
    scope: SCOPE,
    aud: sa.tokenUri,
    iat: nowSec,
    exp: nowSec + ASSERTION_TTL_SECONDS,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  // RS256 = RSASSA-PKCS1-v1_5 with SHA-256; the default DER encoding is correct.
  // Pass the digest name explicitly ("sha256") so the signer works on Bun's
  // BoringSSL, which throws ERR_OSSL_NO_DEFAULT_DIGEST otherwise.
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput, "utf8"), crypto.createPrivateKey(sa.privateKey))
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Exchange a service-account assertion for an OAuth2 access token.
 *
 * `fetchFn` and `nowMs` are injectable for tests; the live path uses the global
 * `fetch`. Returns null when the token endpoint declines the assertion.
 */
export async function mintFirebaseAccessToken(
  sa: FirebaseServiceAccount,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const assertion = signServiceAccountAssertion(sa, nowMs);
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString();
  const res = await fetchFn(sa.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = (await res.json()) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return asString((parsed as Record<string, unknown>)["access_token"]) ?? null;
}

/** The project number is the 2nd colon-segment of a Firebase app id. */
export function projectNumberFromAppId(appId: string): string | null {
  const segment = appId.split(":")[1];
  return segment !== undefined && segment !== "" ? segment : null;
}

/**
 * Parse the injected `FIREBASE_SERVICE_ACCOUNT_JSON` env into a service account;
 * throws if unset or malformed. The Gateway sets this at spawn time.
 */
export function serviceAccountFromEnv(): FirebaseServiceAccount {
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
