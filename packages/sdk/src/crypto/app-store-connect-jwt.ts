/**
 * Apple App Store Connect API authentication — a short-lived ES256 JWT.
 *
 * The App Store Connect API authenticates with a JWT bearer token minted from
 * the developer's EC P-256 `.p8` private key (Apple caps the lifetime at 20
 * min). Shared so the gateway sync and a connector's MCP server sign
 * identically without duplicating the flow.
 *
 * See: https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 */

import { signJwt } from "./jwt";

export interface AppStoreConnectJwtParams {
  readonly issuerId: string;
  readonly keyId: string;
  /** Full `.p8` PEM text (`-----BEGIN PRIVATE KEY----- …`). */
  readonly privateKeyPem: string;
}

const AUDIENCE = "appstoreconnect-v1";
const TOKEN_TTL_SECONDS = 600;

/** Mint an ES256 JWT bearer token for the App Store Connect API. */
export function signAppStoreConnectJwt(
  params: AppStoreConnectJwtParams,
  nowMs: number = Date.now(),
): string {
  const nowSec = Math.floor(nowMs / 1000);
  return signJwt({
    header: { alg: "ES256", kid: params.keyId, typ: "JWT" },
    payload: {
      iss: params.issuerId,
      iat: nowSec,
      exp: nowSec + TOKEN_TTL_SECONDS,
      aud: AUDIENCE,
    },
    privateKeyPem: params.privateKeyPem,
    // ES256 = ECDSA over P-256; `ieee-p1363` gives the raw r||s JWS needs.
    dsaEncoding: "ieee-p1363",
  });
}
