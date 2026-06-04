/**
 * Compact JWS (JWT) signing primitive shared by connector auth flows.
 *
 * A first-party connector that authenticates with a signed JWT must sign in
 * TWO places that cannot import each other across the package boundary — the
 * gateway-side sync handler and the connector's own MCP server. Hosting the
 * signer here (the SDK, which both may import) keeps a single source of truth.
 *
 * Uses `node:crypto` only — no runtime dependency, so the SDK stays dep-free.
 */

import crypto from "node:crypto";

/** base64url-encode the JSON serialization of `value` (a JWT header/payload). */
export function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export interface SignJwtOptions {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  /** Full PEM text of the signing private key (`-----BEGIN PRIVATE KEY----- …`). */
  readonly privateKeyPem: string;
  /**
   * ECDSA (e.g. ES256) requires `"ieee-p1363"` — the raw `r||s` encoding JWS
   * mandates. Omit for RSA (e.g. RS256), which uses PKCS#1 v1.5 / DER.
   */
  readonly dsaEncoding?: "ieee-p1363" | "der";
}

/**
 * Sign a compact JWS — `base64url(header).base64url(payload).base64url(sig)` —
 * over SHA-256. The digest name is passed explicitly ("sha256") rather than
 * `null` so the signer works on Bun's BoringSSL, which has no default digest.
 */
export function signJwt(opts: SignJwtOptions): string {
  const signingInput = `${base64UrlJson(opts.header)}.${base64UrlJson(opts.payload)}`;
  const data = Buffer.from(signingInput, "utf8");
  const key = crypto.createPrivateKey(opts.privateKeyPem);
  const signature =
    opts.dsaEncoding === undefined
      ? crypto.sign("sha256", data, key)
      : crypto.sign("sha256", data, { key, dsaEncoding: opts.dsaEncoding });
  return `${signingInput}.${signature.toString("base64url")}`;
}
