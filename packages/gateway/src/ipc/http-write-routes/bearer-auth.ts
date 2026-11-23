import type { ApiScope } from "../../clips/api-scopes.ts";
import { bearerToken } from "../http-auth.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { jsonResponse, rateLimitHeaders, recordRejection, scopeRefusal } from "./responses.ts";
import type { ResolvedRoute, WriteRouteContext } from "./types.ts";

/**
 * 401/403 gate for the agent route, returning the VERIFIED PRINCIPAL on success.
 *
 * Unlike `requireBriefAuth` this returns the label rather than discarding it: the label becomes
 * `caller.clientId` on the egress row, which is the whole attribution claim. A hand-built or
 * body-supplied client id would turn the ledger row from something the gateway observed into
 * something the caller asserted about itself.
 */
export type BearerVerdict = { label: string; scopes: readonly ApiScope[] };

/**
 * The bearer-auth prelude shared by every scoped HTTP write route.
 *
 * This body existed verbatim three times — `requireAgentAuth`, `requireFetchAuth`,
 * `requireBriefAuth` — differing ONLY in which surface supplied `verifyToken`
 * (`ctx.agents` / `ctx.fetch` / `ctx.briefs`). All four surfaces declare the same
 * `(presented: string) => Promise<BearerVerdict | null>` shape, so the difference
 * is a callback, not a control flow.
 *
 * Worth collapsing rather than tolerating: this is I13 rejection-recording, and
 * three copies is three places to forget that the recorded `reason` must track
 * `refusal.status` — 403 is a real scope gap, 500 is a misconfigured
 * `HTTP_ROUTE_AUTH` entry, and logging one as the other misreports a
 * configuration bug as an access-control event.
 */
export async function requireBearerAuth(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
  verifyToken: (presented: string) => Promise<BearerVerdict | null>,
): Promise<Response | BearerVerdict> {
  const presented = bearerToken(req);
  const verdict = presented === undefined ? null : await verifyToken(presented);
  if (verdict === null) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  const refusal = scopeRefusal(route.key, verdict.scopes, limit);
  if (refusal !== null) {
    // See the twin comment in runClipIngestRoute: refusal.status is 403 (a real scope gap) or 500
    // (a misconfigured HTTP_ROUTE_AUTH entry), and the recorded reason must match which happened.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: refusal.status,
      reason: refusal.status === 403 ? "insufficient_scope" : "internal_error",
    });
    return refusal;
  }
  return verdict;
}
