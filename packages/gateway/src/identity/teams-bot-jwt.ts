import type { Database } from "bun:sqlite";
import { JwksCache } from "./jwks-cache.ts";
import { IdTokenVerifier } from "./verifier.ts";

/** Issuer carried by Bot Framework service tokens (the `iss` claim Microsoft mints). */
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
/** OpenID discovery document for the Bot Framework signing keys. */
export const BOT_FRAMEWORK_OPENID_CONFIG =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

const JWKS_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Hard deadline on the one-time OpenID discovery fetch so a stalled IdP can't hang validation. */
const DISCOVERY_TIMEOUT_MS = 5000;

export interface TeamsBotJwtDeps {
  readonly db: Database;
  /** `[chatops].teams_bot_app_id` — the required `aud` claim. */
  readonly teamsBotAppId: string;
  readonly fetchLike?: typeof fetch;
  readonly log?: (msg: string) => void;
}

/**
 * Bot Framework JWT validation for the I13 `/v1/messaging/teams/events` route. Reuses the I18
 * verifier (`identity/verifier.ts` stays the ONLY token-validation path): RS256 against the
 * Bot Framework JWKS (discovered via the OpenID configuration, disk-cached via JwksCache),
 * `iss` pinned to the Bot Framework issuer and `aud` pinned to the configured bot app id.
 * Every failure — bad header, discovery outage, bad signature, wrong aud — returns false
 * (fail-closed); discovery is retried on the next call.
 */
export function buildTeamsBotJwtValidator(
  deps: TeamsBotJwtDeps,
): (authorizationHeader: string | null, nowMs: number) => Promise<boolean> {
  const fetchLike = deps.fetchLike ?? fetch;
  const log = deps.log ?? ((): void => {});
  let verifier: IdTokenVerifier | undefined;

  async function resolveVerifier(): Promise<IdTokenVerifier | undefined> {
    if (verifier !== undefined) return verifier;
    try {
      // Bound the discovery fetch: an unbounded request would let a stalled IdP hang every Teams
      // event handler (the route fails closed on any error/timeout — rediscovered next call).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchLike(BOT_FRAMEWORK_OPENID_CONFIG, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return undefined;
      const cfg = (await res.json()) as { jwks_uri?: unknown };
      if (typeof cfg.jwks_uri !== "string" || cfg.jwks_uri === "") return undefined;
      verifier = new IdTokenVerifier(
        new JwksCache(deps.db, fetchLike, { maxAgeSeconds: JWKS_MAX_AGE_SECONDS }),
        {
          issuer: BOT_FRAMEWORK_ISSUER,
          clientId: deps.teamsBotAppId,
          jwksUri: cfg.jwks_uri,
        },
      );
      return verifier;
    } catch (e) {
      log(`chatops: bot-framework discovery failed: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  return async (authorizationHeader, nowMs) => {
    if (authorizationHeader === null) return false;
    // RFC 7235: the auth scheme is case-insensitive (`Bearer` / `bearer`).
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
    if (match === null) return false;
    const token = (match[1] ?? "").trim();
    if (token === "") return false;
    const v = await resolveVerifier();
    if (v === undefined) return false; // fail-closed; rediscovered on the next call
    try {
      await v.validateIdToken(token, nowMs);
      return true;
    } catch {
      return false;
    }
  };
}
