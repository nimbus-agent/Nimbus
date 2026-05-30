import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "./deployment-rpc.ts";
import { requireBearer } from "./http-auth.ts";
import type { HttpWriteRateLimiter, RateLimitCheck } from "./http-rate-limit.ts";

export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze(["POST /v1/deployments"]);

const MAX_BODY_BYTES = 8 * 1024;
export interface WriteRouteContext {
  readonly writeDb: Database;
  readonly expectedToken: string;
  readonly rateLimiter: HttpWriteRateLimiter;
  readonly nowMs: () => number;
  readonly deployEnvironments?: readonly string[];
  readonly knownServices: () => readonly string[];
}

function rateLimitHeaders(check: RateLimitCheck): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(check.limit),
    "X-RateLimit-Remaining": String(check.remaining),
    "X-RateLimit-Reset": String(Math.ceil(check.resetMs / 1000)),
  };
}

function jsonResponse(
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

function recordRejection(
  ctx: WriteRouteContext,
  args: {
    readonly tokenFingerprint: string;
    readonly resultCode: number;
    readonly reason: string;
    readonly externalId?: string;
    readonly service?: string;
  },
): void {
  try {
    appendAuditEntry(ctx.writeDb, {
      actionType: "deployment.annotation_rejected",
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

function checkAllowlist(req: Request, url: URL): Response | undefined {
  const key = `${req.method} ${url.pathname}`;
  if (WRITE_ROUTE_ALLOWLIST.includes(key)) {
    return undefined;
  }
  if (WRITE_ROUTE_ALLOWLIST.some((r) => r.endsWith(` ${url.pathname}`))) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  return new Response("Not Found", { status: 404 });
}

type AuthOk = { fingerprint: string };

function checkAuth(req: Request, ctx: WriteRouteContext): Response | AuthOk {
  const auth = requireBearer(req, { expectedToken: ctx.expectedToken });
  if (auth.surfaceDisabled === true) {
    return jsonResponse(
      {
        error: "write_surface_disabled",
        hint: "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token <value>'",
      },
      503,
    );
  }
  if (!auth.ok) {
    recordRejection(ctx, {
      tokenFingerprint: auth.fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return { fingerprint: auth.fingerprint };
}

function checkRateLimit(ctx: WriteRouteContext, fingerprint: string): Response | RateLimitCheck {
  const limit = ctx.rateLimiter.check(fingerprint);
  if (limit.allowed) {
    return limit;
  }
  const retryAfter = Math.max(0, Math.ceil((limit.resetMs - ctx.nowMs()) / 1000));
  recordRejection(ctx, { tokenFingerprint: fingerprint, resultCode: 429, reason: "rate_limited" });
  return jsonResponse({ error: "rate_limited" }, 429, {
    ...rateLimitHeaders(limit),
    "Retry-After": String(retryAfter),
  });
}

async function parseBody(
  req: Request,
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
): Promise<Response | { parsed: unknown }> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader !== null) {
    const n = Number.parseInt(lenHeader, 10);
    if (Number.isInteger(n) && n > MAX_BODY_BYTES) {
      recordRejection(ctx, {
        tokenFingerprint: fingerprint,
        resultCode: 413,
        reason: "payload_too_large",
      });
      return jsonResponse({ error: "payload_too_large" }, 413, rateLimitHeaders(limit));
    }
  }
  let bodyBytes: ArrayBuffer;
  try {
    bodyBytes = await req.arrayBuffer();
  } catch {
    recordRejection(ctx, {
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_body",
    });
    return jsonResponse({ error: "invalid_body" }, 400, rateLimitHeaders(limit));
  }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    recordRejection(ctx, {
      tokenFingerprint: fingerprint,
      resultCode: 413,
      reason: "payload_too_large",
    });
    return jsonResponse({ error: "payload_too_large" }, 413, rateLimitHeaders(limit));
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    return { parsed: JSON.parse(text) };
  } catch {
    recordRejection(ctx, {
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_json",
    });
    return jsonResponse({ error: "invalid_json" }, 400, rateLimitHeaders(limit));
  }
}

function extractService(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "service" in parsed) {
    const svc = (parsed as { service?: unknown }).service;
    return typeof svc === "string" ? svc : undefined;
  }
  return undefined;
}

function checkServiceAllowlist(
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

async function runDeploymentRoute(
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
    });
    if (out.kind === "hit") {
      return jsonResponse(out.value, 200, rateLimitHeaders(limit));
    }
    recordRejection(ctx, {
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error_miss",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  } catch (e) {
    if (e instanceof DeploymentRpcError) {
      recordRejection(ctx, {
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
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}

export async function dispatchWriteRoute(req: Request, ctx: WriteRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const allowlistRes = checkAllowlist(req, url);
  if (allowlistRes !== undefined) {
    return allowlistRes;
  }

  const auth = checkAuth(req, ctx);
  if (auth instanceof Response) {
    return auth;
  }

  const limit = checkRateLimit(ctx, auth.fingerprint);
  if (limit instanceof Response) {
    return limit;
  }

  const body = await parseBody(req, ctx, auth.fingerprint, limit);
  if (body instanceof Response) {
    return body;
  }
  const { parsed } = body;

  if (key === "POST /v1/deployments") {
    const svc = extractService(parsed);
    const svcRes = checkServiceAllowlist(ctx, auth.fingerprint, limit, svc);
    if (svcRes !== undefined) {
      return svcRes;
    }
    return runDeploymentRoute(ctx, auth.fingerprint, limit, parsed, svc);
  }
  return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
}

export { tokenFingerprint } from "./http-auth.ts";
