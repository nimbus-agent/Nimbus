// oidc-discovery.ts
import type { FetchLike, OidcDiscovery } from "./types.ts";

export async function fetchOidcDiscovery(
  issuer: string,
  fetchLike: FetchLike,
): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, "");
  const res = await fetchLike(`${base}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`identity: discovery failed (${res.status})`);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object")
    throw new TypeError("identity: malformed discovery document");
  const rec = body as Record<string, unknown>;
  const dev = rec["device_authorization_endpoint"];
  const tok = rec["token_endpoint"];
  const jwks = rec["jwks_uri"];
  if (typeof dev !== "string" || typeof tok !== "string" || typeof jwks !== "string") {
    throw new TypeError(
      "identity: discovery document missing device_authorization_endpoint/token_endpoint/jwks_uri",
    );
  }
  return { issuer: base, deviceAuthorizationEndpoint: dev, tokenEndpoint: tok, jwksUri: jwks };
}
