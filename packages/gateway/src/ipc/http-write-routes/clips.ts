import { ClipValidationError } from "../../clips/clip-ingest.ts";
import { bearerToken } from "../http-auth.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { CLIP_PAIR_REJECT_ACTION, CLIP_REJECT_ACTION } from "./constants.ts";
import { jsonResponse, rateLimitHeaders, recordRejection, scopeRefusal } from "./responses.ts";
import type { ClipsWriteSurface, ResolvedRoute, WriteRouteContext } from "./types.ts";

export async function runClipIngestRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.clips is defined for every clip-kind route.
  const clips = ctx.clips as ClipsWriteSurface;
  const presented = bearerToken(req);
  const verdict = presented === undefined ? null : await clips.verifyToken(presented);
  if (verdict === null) {
    recordRejection(ctx, {
      actionType: CLIP_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  const refusal = scopeRefusal(route.key, verdict.scopes, limit);
  if (refusal !== null) {
    // refusal.status is either 403 (real scope gap) or 500 (HTTP_ROUTE_AUTH entry for this key
    // is misconfigured — see scopeRefusal). Record whichever actually happened, not a hardcoded
    // 403/insufficient_scope that would mislabel a table misconfiguration as a client error.
    recordRejection(ctx, {
      actionType: CLIP_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: refusal.status,
      reason: refusal.status === 403 ? "insufficient_scope" : "internal_error",
    });
    return refusal;
  }
  try {
    const out = clips.ingest(parsed);
    return jsonResponse(out, 200, rateLimitHeaders(limit));
  } catch (e) {
    if (e instanceof ClipValidationError) {
      recordRejection(ctx, {
        actionType: CLIP_REJECT_ACTION,
        tokenFingerprint: fingerprint,
        resultCode: 400,
        reason: e.field === undefined ? "invalid_request" : `invalid_${e.field}`,
      });
      return jsonResponse(
        { error: "invalid_request", ...(e.field === undefined ? {} : { field: e.field }) },
        400,
        rateLimitHeaders(limit),
      );
    }
    recordRejection(ctx, {
      actionType: CLIP_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}

export function extractCode(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "code" in parsed) {
    const c = (parsed as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export async function runClipPairConfirmRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.clips is defined for every clip-kind route.
  const clips = ctx.clips as ClipsWriteSurface;
  const code = extractCode(parsed);
  const confirmed = code === undefined ? null : clips.pairing.confirm(code);
  if (confirmed === null) {
    recordRejection(ctx, {
      actionType: CLIP_PAIR_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 403,
      reason: "no_active_window_or_bad_code",
    });
    return jsonResponse({ error: "pairing_failed" }, 403, rateLimitHeaders(limit));
  }
  const token = await clips.mintToken(confirmed.label, confirmed.scopes);
  return jsonResponse(
    { token, label: confirmed.label, scopes: [...confirmed.scopes] },
    200,
    rateLimitHeaders(limit),
  );
}
