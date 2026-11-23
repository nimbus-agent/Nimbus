import { ReportTooLargeError } from "../../briefs/brief-save.ts";
import {
  BriefValidationError,
  validateCreateInput,
  validateSourceInput,
} from "../../briefs/brief-validate.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { requireBearerAuth } from "./bearer-auth.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { BriefsWriteSurface, ResolvedRoute, WriteRouteContext } from "./types.ts";

/**
 * `Response | null` rather than the verdict: the four brief routes only need to
 * know whether they were refused, and keeping that shape leaves their call
 * sites (`if (denied !== null) return denied;`) unchanged.
 */
export async function requireBriefAuth(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
): Promise<Response | null> {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const outcome = await requireBearerAuth(ctx, route, fingerprint, req, limit, (t) =>
    briefs.verifyToken(t),
  );
  return outcome instanceof Response ? outcome : null;
}

export function briefValidationResponse(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  e: unknown,
): Response {
  if (e instanceof BriefValidationError) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
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
    actionType: route.rejectAction,
    tokenFingerprint: fingerprint,
    resultCode: 500,
    reason: "internal_error",
  });
  return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
}

export async function runBriefCreateRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const denied = await requireBriefAuth(ctx, route, fingerprint, req, limit);
  if (denied !== null) return denied;
  try {
    const input = validateCreateInput(parsed);
    const out = briefs.controller.create(input);
    if ("error" in out) {
      recordRejection(ctx, {
        actionType: route.rejectAction,
        tokenFingerprint: fingerprint,
        resultCode: 503,
        reason: "briefs_busy",
      });
      // NOT a 429, and this is load-bearing rather than a style choice: a concurrency
      // Retry-After derived from run expiry is up to 1800s (the full TTL), the shipped clipper
      // clamps Retry-After to 120s, and it would retry straight back into the same
      // rejection with no path forward. Emitting the rate-limit bucket's 60s instead
      // would be a different lie — nothing frees at 60s. 503 with NO Retry-After keeps
      // this out of retry pacing entirely. See the spec's "The concurrency cap is not
      // a 429" section before changing it back.
      return jsonResponse(
        {
          error: "briefs_busy",
          activeRuns: out.activeRuns,
          oldestExpiresInSeconds: out.oldestExpiresInSeconds,
        },
        503,
        rateLimitHeaders(limit),
      );
    }
    return jsonResponse(
      { id: out.run.id, status: "collecting", expected: out.run.declared.size },
      200,
      rateLimitHeaders(limit),
    );
  } catch (e) {
    return briefValidationResponse(ctx, route, fingerprint, limit, e);
  }
}

/** Resolves a run id to a run, or the 404/410 Response the client keys its discard on. */
export function lookupRun(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  id: string,
  limit: RateLimitCheck,
) {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const run = briefs.controller.get(id);
  if (run !== null) return run;
  if (briefs.controller.wasKnown(id)) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 410,
      reason: "expired",
    });
    return jsonResponse({ error: "expired" }, 410, rateLimitHeaders(limit));
  }
  recordRejection(ctx, {
    actionType: route.rejectAction,
    tokenFingerprint: fingerprint,
    resultCode: 404,
    reason: "not_found",
  });
  return jsonResponse({ error: "not_found" }, 404, rateLimitHeaders(limit));
}

export type BriefRunRecord = Exclude<ReturnType<typeof lookupRun>, Response>;

/**
 * Auth, resolve the run, and require it to be in `expected` state.
 *
 * The three brief routes that mutate a run repeated this prelude verbatim,
 * differing only in the state they demand — `collecting` for add-source,
 * `done` for save. Collapsing it keeps the 409 `invalid_state` rejection
 * recorded in exactly one place; three copies is three chances for the
 * recorded `resultCode` and the returned status to drift apart.
 *
 * `runBriefRunRoute` deliberately does NOT use this: a re-run is idempotent and
 * answers 200 with the run's current state rather than 409, so it shares the
 * auth+lookup half only.
 */
export async function requireBriefRunInState(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
  expected: BriefRunRecord["status"],
): Promise<Response | BriefRunRecord> {
  const denied = await requireBriefAuth(ctx, route, fingerprint, req, limit);
  if (denied !== null) return denied;
  const found = lookupRun(ctx, route, fingerprint, route.id as string, limit);
  if (found instanceof Response) return found;
  if (found.status !== expected) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 409,
      reason: "invalid_state",
    });
    return jsonResponse({ error: "invalid_state" }, 409, rateLimitHeaders(limit));
  }
  return found;
}

export async function runBriefSourceRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const found = await requireBriefRunInState(ctx, route, fingerprint, req, limit, "collecting");
  if (found instanceof Response) return found;
  try {
    const input = validateSourceInput(parsed);
    // Re-check synchronously, right before the mutation: `requireBriefRunInState` resolved the
    // state, then the async return handed control back through the microtask queue, and a run
    // started in that gap (another request's `startRun`) must not receive a source after it
    // left `collecting`. Nothing awaits between this check and `addSource`.
    if (found.status !== "collecting") {
      recordRejection(ctx, {
        actionType: route.rejectAction,
        tokenFingerprint: fingerprint,
        resultCode: 409,
        reason: "invalid_state",
      });
      return jsonResponse({ error: "invalid_state" }, 409, rateLimitHeaders(limit));
    }
    const out = briefs.controller.addSource(found, input);
    if ("error" in out) {
      if (out.error === "undeclared") {
        recordRejection(ctx, {
          actionType: route.rejectAction,
          tokenFingerprint: fingerprint,
          resultCode: 400,
          reason: "invalid_url",
        });
        return jsonResponse(
          { error: "invalid_request", field: "url" },
          400,
          rateLimitHeaders(limit),
        );
      }
      recordRejection(ctx, {
        actionType: route.rejectAction,
        tokenFingerprint: fingerprint,
        resultCode: 413,
        reason: out.error,
      });
      return jsonResponse(
        { error: "payload_too_large", detail: out.error },
        413,
        rateLimitHeaders(limit),
      );
    }
    return jsonResponse(
      { accepted: out.accepted, received: out.received, expected: found.declared.size },
      200,
      rateLimitHeaders(limit),
    );
  } catch (e) {
    return briefValidationResponse(ctx, route, fingerprint, limit, e);
  }
}

export async function runBriefRunRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
): Promise<Response> {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const denied = await requireBriefAuth(ctx, route, fingerprint, req, limit);
  if (denied !== null) return denied;
  const found = lookupRun(ctx, route, fingerprint, route.id as string, limit);
  if (found instanceof Response) return found;
  // Idempotent: re-calling run is a no-op that reports where the run already is.
  if (found.status !== "collecting") {
    return jsonResponse({ status: found.status }, 200, rateLimitHeaders(limit));
  }
  if (found.sources.size === 0 && !found.useIndex) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_sources",
    });
    return jsonResponse(
      { error: "invalid_request", field: "sources" },
      400,
      rateLimitHeaders(limit),
    );
  }
  briefs.startRun(found.id);
  return jsonResponse({ status: "running" }, 200, rateLimitHeaders(limit));
}

export async function runBriefSaveRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
): Promise<Response> {
  const briefs = ctx.briefs as BriefsWriteSurface;
  const found = await requireBriefRunInState(ctx, route, fingerprint, req, limit, "done");
  if (found instanceof Response) return found;
  try {
    return jsonResponse(briefs.save(found.id), 200, rateLimitHeaders(limit));
  } catch (e) {
    // Narrow: a bare catch here reports assemble's "run not found" as a SIZE problem,
    // sending the client down a debugging path unrelated to the actual fault.
    if (e instanceof ReportTooLargeError) {
      recordRejection(ctx, {
        actionType: route.rejectAction,
        tokenFingerprint: fingerprint,
        resultCode: 409,
        reason: "report_too_large",
      });
      return jsonResponse({ error: "report_too_large" }, 409, rateLimitHeaders(limit));
    }
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}
