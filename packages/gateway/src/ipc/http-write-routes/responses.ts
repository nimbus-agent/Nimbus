import type { ApiScope } from "../../clips/api-scopes.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { enforceClipScope } from "../http-route-auth.ts";
import { BRIEF_DISABLED_HINT } from "./constants.ts";
import type { WriteRouteContext } from "./types.ts";

export function rateLimitHeaders(check: RateLimitCheck): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(check.limit),
    "X-RateLimit-Remaining": String(check.remaining),
    "X-RateLimit-Reset": String(Math.ceil(check.resetMs / 1000)),
  };
}

export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
}

export function recordRejection(
  ctx: WriteRouteContext,
  args: {
    readonly actionType: string;
    readonly tokenFingerprint: string;
    readonly resultCode: number;
    readonly reason: string;
    readonly externalId?: string;
    readonly service?: string;
  },
): void {
  try {
    appendAuditEntry(ctx.writeDb, {
      actionType: args.actionType,
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        token_fingerprint: args.tokenFingerprint,
        source_ip: "127.0.0.1",
        result_code: args.resultCode,
        reason: args.reason,
        service: args.service ?? null,
        external_id: args.externalId ?? null,
      }),
      timestamp: ctx.nowMs(),
    });
  } catch {
    /* audit best-effort */
  }
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** 404 that names the cause, so the client can write first-run copy instead of guessing. */
export function briefsDisabled(): Response {
  return jsonResponse({ error: "briefs_disabled", hint: BRIEF_DISABLED_HINT }, 404);
}

/**
 * Refuses an authenticated-but-unscoped caller with 403, or a misconfigured route with 500.
 * Returns null only when the caller is genuinely allowed through.
 *
 * 403 rather than 401 for a real scope gap, deliberately: the token IS valid, so reporting 401
 * would send a client into a re-pair loop that cannot fix anything.
 *
 * Takes `route.key` — the STATIC route constant — never the raw request path. `clipScopeFor`
 * (via `enforceClipScope`) looks up the requirement by that literal key; a raw path (with the id
 * substituted in) would miss every templated key, and `enforceClipScope` then returns its
 * misconfigured verdict, so the request is refused with 500 `internal_error` (never waved through).
 *
 * `scopeRefusal` has two callers, both labeled-token routes: `runClipIngestRoute` (kind
 * `clipIngest`) directly, and the shared bearer gate `requireBearerAuth`, through which
 * `requireBriefAuth` (kinds `briefCreate`/`briefSource`/`briefRun`/`briefSave`),
 * `requireAgentAuth` (`agentInvoke`) and `requireFetchAuth` (`itemsFetch`) all pass. So
 * `enforceClipScope` returning "misconfigured" here means the table's entry for this key was
 * removed or changed away from `kind: "clip"`, not that the route legitimately needs no scope.
 * FAIL CLOSED (500), never treat that as "no refusal".
 */
export function scopeRefusal(
  routeKey: string,
  granted: readonly ApiScope[],
  limit: RateLimitCheck,
): Response | null {
  const verdict = enforceClipScope(routeKey, granted);
  if (verdict.ok) return null;
  return jsonResponse(verdict.body, verdict.status, rateLimitHeaders(limit));
}
