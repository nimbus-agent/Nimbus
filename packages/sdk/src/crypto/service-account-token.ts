/**
 * Google service-account OAuth2 access tokens via the JWT-bearer grant.
 *
 * Google Cloud REST APIs (App Distribution, BigQuery, …) accept a short-lived
 * OAuth2 access token. This mints one from a service-account key (the JSON the
 * developer downloads) by signing an RS256 JWT assertion and exchanging it at
 * the token endpoint — no `googleapis` dependency. Shared so the gateway sync
 * and a connector's MCP server sign identically without duplicating the flow.
 *
 * See: https://developers.google.com/identity/protocols/oauth2/service-account
 */

import { signJwt } from "./jwt";

const SCOPE_CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Google caps SA assertion lifetime at 1 hour. */
const ASSERTION_TTL_SECONDS = 3600;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface GoogleServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a service-account key JSON string into the fields the JWT-bearer flow
 * needs. Returns null on malformed JSON or a missing `client_email` /
 * `private_key`; `token_uri` defaults to Google's endpoint when absent.
 */
export function parseServiceAccountJson(json: string): GoogleServiceAccount | null {
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

/**
 * Sign an RS256 JWT assertion for the JWT-bearer grant. `nowMs` is injectable
 * so tests can assert deterministic `iat`/`exp`; `scope` defaults to
 * `cloud-platform`.
 */
export function signServiceAccountAssertion(
  sa: GoogleServiceAccount,
  nowMs: number = Date.now(),
  scope: string = SCOPE_CLOUD_PLATFORM,
): string {
  const nowSec = Math.floor(nowMs / 1000);
  return signJwt({
    header: { alg: "RS256", typ: "JWT" },
    payload: {
      iss: sa.clientEmail,
      scope,
      aud: sa.tokenUri,
      iat: nowSec,
      exp: nowSec + ASSERTION_TTL_SECONDS,
    },
    privateKeyPem: sa.privateKey,
  });
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Exchange a service-account assertion for an OAuth2 access token. `fetchFn` and
 * `nowMs` are injectable for tests; the live path uses the global `fetch`.
 * Returns null when the token endpoint declines the assertion.
 */
export async function mintGoogleAccessToken(
  sa: GoogleServiceAccount,
  fetchFn: FetchLike = globalThis.fetch as FetchLike,
  nowMs: number = Date.now(),
  scope: string = SCOPE_CLOUD_PLATFORM,
): Promise<string | null> {
  const assertion = signServiceAccountAssertion(sa, nowMs, scope);
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
