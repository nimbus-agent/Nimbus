import { DeploymentRpcError, dispatchDeploymentRpc } from "../deployment-rpc.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";

import { DEPLOY_REJECT_ACTION } from "./constants.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { WriteRouteContext } from "./types.ts";

export function extractService(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "service" in parsed) {
    const svc = (parsed as { service?: unknown }).service;
    return typeof svc === "string" ? svc : undefined;
  }
  return undefined;
}

export function checkServiceAllowlist(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  svc: string | undefined,
): Response | undefined {
  if (typeof svc !== "string" || svc.length === 0) {
    return undefined;
  }
  const known = ctx.knownServices();
  if (known.includes(svc)) {
    return undefined;
  }
  recordRejection(ctx, {
    actionType: DEPLOY_REJECT_ACTION,
    tokenFingerprint: fingerprint,
    resultCode: 400,
    reason: "unknown_service",
    service: svc,
  });
  return jsonResponse(
    { error: "unknown_service", service: svc, known_services: known.slice(0, 25) },
    400,
    rateLimitHeaders(limit),
  );
}

export async function runDeploymentRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
  svc: string | undefined,
): Promise<Response> {
  try {
    const out = await dispatchDeploymentRpc("deployment.annotate", parsed, {
      db: ctx.writeDb,
      nowMs: ctx.nowMs,
      ...(ctx.deployEnvironments === undefined
        ? {}
        : { deployEnvironments: ctx.deployEnvironments }),
      ...(ctx.graphDeployment === undefined ? {} : { graphDeployment: ctx.graphDeployment }),
    });
    if (out.kind === "hit") {
      return jsonResponse(out.value, 200, rateLimitHeaders(limit));
    }
    recordRejection(ctx, {
      actionType: DEPLOY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error_miss",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  } catch (e) {
    if (e instanceof DeploymentRpcError) {
      recordRejection(ctx, {
        actionType: DEPLOY_REJECT_ACTION,
        tokenFingerprint: fingerprint,
        resultCode: 400,
        reason: e.field === undefined ? "invalid_request" : `invalid_${e.field}`,
        ...(typeof svc === "string" ? { service: svc } : {}),
      });
      return jsonResponse(
        {
          error: "invalid_request",
          details:
            e.field === undefined
              ? [{ reason: e.message }]
              : [{ field: e.field, reason: e.message }],
        },
        400,
        rateLimitHeaders(limit),
      );
    }
    recordRejection(ctx, {
      actionType: DEPLOY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}
