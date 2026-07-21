import { createHash } from "node:crypto";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";

export const HTTP_API_DEPLOYMENT_TOKEN_VAULT_KEY = "http_api.deployment_token";

const BEARER_PREFIX = "Bearer ";

export function tokenFingerprint(token: string | undefined): string {
  if (token === undefined || token === "") return "unknown";
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

export interface RequireBearerContext {
  readonly expectedToken: string;
}

export interface RequireBearerResult {
  readonly ok: boolean;
  readonly fingerprint: string;
  readonly surfaceDisabled?: boolean;
}

function extractBearer(req: Request): string | undefined {
  const raw = req.headers.get("authorization");
  if (raw === null) return undefined;
  if (!raw.startsWith(BEARER_PREFIX)) return undefined;
  return raw.slice(BEARER_PREFIX.length);
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header, or
 * undefined when the header is absent or uses another scheme.
 *
 * Canonical home for this parse: the I13 write dispatcher, the clip-related
 * read route, and the brief read route all authenticate off the same header,
 * and three hand-rolled copies is three chances to disagree about it.
 */
export function bearerToken(req: Request): string | undefined {
  const raw = req.headers.get("authorization");
  return raw?.startsWith("Bearer ") === true ? raw.slice("Bearer ".length) : undefined;
}

export function requireBearer(req: Request, ctx: RequireBearerContext): RequireBearerResult {
  if (ctx.expectedToken === "") {
    return { ok: false, fingerprint: "unknown", surfaceDisabled: true };
  }
  const presented = extractBearer(req);
  if (presented === undefined) {
    return { ok: false, fingerprint: "unknown" };
  }
  const ok = constantTimeStringEqual(presented, ctx.expectedToken);
  return { ok, fingerprint: tokenFingerprint(presented) };
}
