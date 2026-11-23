import type { RateLimitCheck } from "../http-rate-limit.ts";
import { type BearerVerdict, requireBearerAuth } from "./bearer-auth.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { FetchWriteSurface, ResolvedRoute, WriteRouteContext } from "./types.ts";

export function extractUrl(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "url" in parsed) {
    const u = (parsed as { url?: unknown }).url;
    return typeof u === "string" ? u : undefined;
  }
  return undefined;
}

/**
 * 401/403 gate for the items-fetch route, mirroring `requireAgentAuth`. Returns the verified
 * principal on success, and the route now USES it: its `label` becomes the egress row's
 * `source_id`, so the ledger can say WHICH client asked for a fetch.
 *
 * That label is the only part of the row the caller influences, and only through a token the
 * gateway itself verified — the row's `destination` remains the SERVICE id `targetedFetch` derives
 * internally from the URL's host, never anything the caller supplied.
 */
export async function requireFetchAuth(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
): Promise<Response | BearerVerdict> {
  const fetchSurface = ctx.fetch as FetchWriteSurface;
  return requireBearerAuth(ctx, route, fingerprint, req, limit, (t) => fetchSurface.verifyToken(t));
}

export async function runItemsFetchRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.fetch is defined for every itemsFetch-kind route.
  const fetchSurface = ctx.fetch as FetchWriteSurface;
  const auth = await requireFetchAuth(ctx, route, fingerprint, req, limit);
  if (auth instanceof Response) return auth;

  const url = extractUrl(parsed);
  if (url === undefined) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "missing_url",
    });
    return jsonResponse({ error: "missing_url" }, 400, rateLimitHeaders(limit));
  }

  try {
    // Every TargetedFetchOutcome — `indexed` and every miss arm alike — is a 200: a miss is a
    // legitimate answer to a well-formed request, not a client error. Only a malformed body
    // (above) or an auth/rate-limit failure produces a non-2xx from this route.
    // `auth.label` is the VERIFIED token label, not a body field: a caller-supplied one would let
    // a client file its egress under another client's name.
    const outcome = await fetchSurface.fetchItem(url, auth.label);
    return jsonResponse(outcome, 200, rateLimitHeaders(limit));
  } catch {
    // Reached when the egress append fails (I29 fail-closed) or the connector call throws
    // unexpectedly. No row means no fetch either way; the caller gets a 500 and may retry.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}
