import crypto from "node:crypto";

/**
 * App Store Connect API authentication (connector-local copy).
 *
 * The gateway sync and this MCP server cannot share code, so this mirrors the
 * gateway-side `testflight-jwt.ts`: a short-lived ES256 JWT signed with the
 * developer's EC P-256 `.p8` private key. Apple caps token lifetime at 20 min.
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
const TOKEN_TTL_SECONDS = 600;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Mint an ES256 JWT bearer token for the App Store Connect API. */
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
  // ES256 = ECDSA over P-256 with SHA-256. Pass the digest name explicitly
  // ("sha256") rather than `null` so the signer works on Bun's BoringSSL
  // (no default digest for EC keys); `ieee-p1363` gives the raw r||s JWS needs.
  const signature = crypto
    .sign("sha256", Buffer.from(signingInput, "utf8"), {
      key: crypto.createPrivateKey(params.privateKeyPem),
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Read the three `TESTFLIGHT_*` env vars; throws if any is unset. */
export function jwtParamsFromEnv(): TestflightJwtParams {
  const issuerId = process.env["TESTFLIGHT_ISSUER_ID"]?.trim();
  const keyId = process.env["TESTFLIGHT_KEY_ID"]?.trim();
  const privateKeyPem = process.env["TESTFLIGHT_PRIVATE_KEY"];
  if (issuerId === undefined || issuerId === "") {
    throw new Error("TESTFLIGHT_ISSUER_ID is not set");
  }
  if (keyId === undefined || keyId === "") {
    throw new Error("TESTFLIGHT_KEY_ID is not set");
  }
  if (privateKeyPem === undefined || privateKeyPem.trim() === "") {
    throw new Error("TESTFLIGHT_PRIVATE_KEY is not set");
  }
  return { issuerId, keyId, privateKeyPem };
}
