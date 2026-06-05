// verifier.ts
import type { IdentityStore } from "./identity-store.ts";
import type { JwksCache, PublicJwk } from "./jwks-cache.ts";
import type { ValidatedClaims } from "./types.ts";

const CLOCK_SKEW_SECONDS = 60;

export class IdTokenValidationError extends Error {}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return new Uint8Array(Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64"));
}
function b64urlToJson(s: string): Record<string, unknown> {
  const obj: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new IdTokenValidationError("identity: JWT segment is not an object");
  }
  return obj as Record<string, unknown>;
}

function parseJwt(jwt: string): JwtParts {
  const segs = jwt.split(".");
  if (segs.length !== 3) throw new IdTokenValidationError("identity: malformed JWT");
  const [h, p, s] = segs as [string, string, string];
  return {
    header: b64urlToJson(h),
    payload: b64urlToJson(p),
    signingInput: `${h}.${p}`,
    signature: b64urlToBytes(s),
  };
}

async function verifyRs256(
  jwk: PublicJwk,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new Uint8Array(signature),
    new Uint8Array(new TextEncoder().encode(signingInput)),
  );
}

export class IdTokenVerifier {
  constructor(
    private readonly jwks: JwksCache,
    private readonly cfg: { issuer: string; clientId: string; jwksUri: string },
  ) {}

  /** Resolves the signing key for the JWT header and verifies the RS256 signature. */
  private async verifySignature(parts: JwtParts, nowMs: number): Promise<void> {
    const { header, signingInput, signature } = parts;
    if (header["alg"] !== "RS256") {
      throw new IdTokenValidationError(
        `identity: unsupported alg ${String(header["alg"])} (RS256 only)`,
      );
    }
    const kid = header["kid"];
    if (typeof kid !== "string") throw new IdTokenValidationError("identity: missing kid");
    const jwk = await this.jwks.getKey(this.cfg.issuer, this.cfg.jwksUri, kid, nowMs);
    if (jwk === undefined)
      throw new IdTokenValidationError("identity: no usable signing key (rotated/offline)");
    if (!(await verifyRs256(jwk, signingInput, signature))) {
      throw new IdTokenValidationError("identity: signature verification failed");
    }
  }

  /** Validates iss/aud/exp/nbf/sub and returns the leak-proof claims shape. */
  private validateClaims(payload: Record<string, unknown>, nowMs: number): ValidatedClaims {
    if (payload["iss"] !== this.cfg.issuer)
      throw new IdTokenValidationError("identity: issuer mismatch");
    const aud = payload["aud"];
    const audOk =
      aud === this.cfg.clientId || (Array.isArray(aud) && aud.includes(this.cfg.clientId));
    if (!audOk) throw new IdTokenValidationError("identity: audience mismatch");
    const nowSec = nowMs / 1000;
    const exp = payload["exp"];
    // Reject if the token is expired. Clock skew tolerance applies to nbf only.
    if (typeof exp !== "number" || nowSec > exp) {
      throw new IdTokenValidationError("identity: token expired");
    }
    const nbf = payload["nbf"];
    if (typeof nbf === "number" && nowSec + CLOCK_SKEW_SECONDS < nbf) {
      throw new IdTokenValidationError("identity: token not yet valid");
    }
    const sub = payload["sub"];
    if (typeof sub !== "string" || sub.length === 0)
      throw new IdTokenValidationError("identity: missing sub");
    return {
      sub,
      ...(typeof payload["email"] === "string" ? { email: payload["email"] } : {}),
      iss: this.cfg.issuer,
      aud: this.cfg.clientId,
      exp,
      ...(typeof nbf === "number" ? { nbf } : {}),
      raw: payload,
    };
  }

  /** I18 — the ONLY ID-token validation path. RS256 only (Okta/Entra/Auth0/Google). nowMs is injected. */
  async validateIdToken(jwt: string, nowMs: number): Promise<ValidatedClaims> {
    const parts = parseJwt(jwt);
    await this.verifySignature(parts, nowMs);
    return this.validateClaims(parts.payload, nowMs);
  }
}

/** The federation gate's single question. Pure/synchronous — no network. */
export function isOperatorValid(
  store: IdentityStore,
  issuer: string,
  nowMs: number,
  graceSeconds: number,
): boolean {
  const s = store.getSession(issuer);
  if (s === undefined) return false;
  if (s.status !== "active") return false;
  return nowMs <= s.expiresAt + graceSeconds * 1000;
}
