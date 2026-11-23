import { runScimWrite } from "../../identity/scim-http-routes.ts";
import { ScimError } from "../../identity/scim-service.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { SCIM_REJECT_ACTION } from "./constants.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { ResolvedRoute, ScimWriteSurface, WriteRouteContext } from "./types.ts";

/** Maps a SCIM HTTP status to the audit `reason` tag. */
export function scimReason(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "scim_error";
}

/** Re-attaches the rate-limit headers to a SCIM handler Response without consuming its body. */
export function withRateLimitHeaders(res: Response, limit: RateLimitCheck): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(rateLimitHeaders(limit))) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

export async function runScimRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.scim is defined for every scim-kind route.
  const scim = ctx.scim as ScimWriteSurface;
  try {
    const res = await runScimWrite(route.key, route.id, parsed, {
      writeDb: ctx.writeDb,
      store: scim.store,
      identity: scim.identity,
      nowMs: ctx.nowMs,
    });
    return withRateLimitHeaders(res, limit);
  } catch (e) {
    if (e instanceof ScimError) {
      recordRejection(ctx, {
        actionType: SCIM_REJECT_ACTION,
        tokenFingerprint: fingerprint,
        resultCode: e.status,
        reason: scimReason(e.status),
        ...(route.id === undefined ? {} : { externalId: route.id }),
      });
      return jsonResponse(
        { detail: e.message, status: e.status },
        e.status,
        rateLimitHeaders(limit),
      );
    }
    recordRejection(ctx, {
      actionType: SCIM_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
      ...(route.id === undefined ? {} : { externalId: route.id }),
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}
