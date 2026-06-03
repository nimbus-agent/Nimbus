import crypto from "node:crypto";

/**
 * App Store Connect API authentication.
 *
 * App Store Connect uses a short-lived ES256 JWT bearer token signed with an
 * EC P-256 private key (the `.p8` the developer downloads). The token's claims
 * are fixed by Apple: the issuer id, the key id (in the header `kid`), an
 * `exp` no more than 20 minutes out, and the audience `appstoreconnect-v1`.
 *
 * See: https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 */

export interface TestflightJwtParams {
  readonly issuerId: string;
  readonly keyId: string;
  /** Full `.p8` PEM text (`-----BEGIN PRIVATE KEY----- …`). */
  readonly privateKeyPem: string;
}

const AUDIENCE = "appstoreconnect-v1";
/** Apple caps token lifetime at 20 minutes; we use 10 to stay well inside it. */
const TOKEN_TTL_SECONDS = 600;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Mint an ES256 JWT bearer token for the App Store Connect API.
 *
 * `nowMs` is injectable so tests can assert deterministic `iat`/`exp` claims.
 */
export function signTestflightJwt(params: TestflightJwtParams, nowMs: number = Date.now()): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", kid: params.keyId, typ: "JWT" };
  const payload = {
    iss: params.issuerId,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SECONDS,
    aud: AUDIENCE,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  // ES256 = ECDSA over P-256 with SHA-256. `dsaEncoding: "ieee-p1363"` yields
  // the raw r||s the JWT/JWS spec requires (NOT the default DER). We pass the
  // digest name explicitly ("sha256") rather than `null` so the signer works
  // on Bun's BoringSSL, which has no default digest for EC keys.
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: crypto.createPrivateKey(params.privateKeyPem),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Build the `Authorization: Bearer <jwt>` header set the API expects. */
export function testflightAuthHeaders(
  params: TestflightJwtParams,
  nowMs?: number,
): Record<string, string> {
  return {
    Authorization: `Bearer ${signTestflightJwt(params, nowMs)}`,
    Accept: "application/json",
  };
}
