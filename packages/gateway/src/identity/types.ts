// types.ts
/** A `fetch`-shaped injectable for deterministic tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
/** Injected clock (ms). Module code must never call Date.now() directly in hot paths under test. */
export type Clock = () => number;

/** Builds an `application/x-www-form-urlencoded` POST `RequestInit` — the OAuth token/device wire format. */
export function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  };
}

export interface OidcDiscovery {
  readonly issuer: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export interface DeviceAuthResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export interface TokenResponse {
  readonly idToken: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

export interface ValidatedClaims {
  readonly sub: string;
  readonly email?: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number; // seconds
  readonly nbf?: number; // seconds
  readonly raw: Record<string, unknown>;
}

export interface IdentitySession {
  readonly issuer: string;
  readonly externalId: string;
  readonly email: string | null;
  readonly validatedAt: number; // ms
  readonly expiresAt: number; // ms
  readonly status: "active" | "expired" | "deprovisioned";
}

export interface ScimUser {
  readonly externalId: string;
  readonly userName: string | null;
  readonly email: string | null;
  readonly active: boolean;
  readonly attrs: Record<string, unknown>;
}

export type BindingSource = "handshake" | "admin";
export interface IdentityBinding {
  readonly externalId: string;
  readonly peerId: string;
  readonly boundAt: number;
  readonly boundBy: BindingSource;
  readonly revokedAt: number | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError("identity: expected a JSON object");
  }
  return v as Record<string, unknown>;
}
function str(rec: Record<string, unknown>, k: string): string | undefined {
  const v = rec[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(rec: Record<string, unknown>, k: string): number | undefined {
  const v = rec[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseTokenResponse(v: unknown): TokenResponse {
  const rec = asRecord(v);
  const idToken = str(rec, "id_token");
  if (idToken === undefined) throw new TypeError("identity: token response missing id_token");
  const accessToken = str(rec, "access_token");
  const refreshToken = str(rec, "refresh_token");
  const expiresIn = num(rec, "expires_in");
  return {
    idToken,
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresIn }),
  };
}

export function parseDeviceAuthResponse(v: unknown): DeviceAuthResponse {
  const rec = asRecord(v);
  const deviceCode = str(rec, "device_code");
  const userCode = str(rec, "user_code");
  const verificationUri = str(rec, "verification_uri");
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new TypeError("identity: malformed device authorization response");
  }
  const verificationUriComplete = str(rec, "verification_uri_complete");
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    interval: num(rec, "interval") ?? 5,
    expiresIn: num(rec, "expires_in") ?? 600,
  };
}
