import type { AgentHttpInvoker } from "../../agent-runs/agent-http-invoke.ts";
import { AGENT_BUSY_RETRY_AFTER_SECONDS } from "../../agent-runs/agent-run-store.ts";
import type { RateLimitCheck } from "../http-rate-limit.ts";
import { type BearerVerdict, requireBearerAuth } from "./bearer-auth.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { AgentsWriteSurface, ResolvedRoute, WriteRouteContext } from "./types.ts";

export async function requireAgentAuth(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  req: Request,
  limit: RateLimitCheck,
): Promise<Response | BearerVerdict> {
  const agents = ctx.agents as AgentsWriteSurface;
  return requireBearerAuth(ctx, route, fingerprint, req, limit, (t) => agents.verifyToken(t));
}

export async function runAgentInvokeRoute(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.agents is defined for every agent-kind route.
  const agents = ctx.agents as AgentsWriteSurface;
  const auth = await requireAgentAuth(ctx, route, fingerprint, req, limit);
  if (auth instanceof Response) return auth;

  let out: Awaited<ReturnType<AgentHttpInvoker>>;
  try {
    // The body goes through VERBATIM to the gateway's own validator. No params are built here and
    // no schema is mirrored, so there is no second contract to drift.
    out = await agents.invoke(route.id as string, parsed, auth.label);
  } catch {
    // Reached when the egress append fails: I29 fail-closed. No run was created and no brief was
    // emitted; the caller gets a 500 and may retry.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }

  if (out.ok) {
    // 202: the run is accepted and in progress, not complete. Poll GET /v1/agents/runs/{id}.
    return jsonResponse({ runId: out.runId }, 202, rateLimitHeaders(limit));
  }

  // Every refusal below is audited, matching runClipIngestRoute and runBriefCreateRoute — both of
  // which record their 400 validation refusals, not only their auth failures. The audit log is how
  // an owner sees refused external attempts, so a caller enumerating agent names (repeated 404s) or
  // hammering a saturated run store (repeated 429s) must leave a trace rather than none.
  if (out.reason === "unknown_agent") {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 404,
      reason: "unknown_agent",
    });
    return jsonResponse({ error: "unknown_agent" }, 404, rateLimitHeaders(limit));
  }
  if (out.reason === "busy") {
    // 429, matching the rate limiter's own refusal code: both mean "retry later", and a client that
    // already handles 429 needs no second code path. The AgentRunController cap — not the 60/min
    // token limiter — is the real bound on agent runs.
    //
    // Retry-After is MANDATORY here, not a nicety. `checkRateLimit` (this file) already sends it on
    // the OTHER 429 this route can produce, so omitting it would mean two 429s from one endpoint,
    // one honouring the header contract and one not — and a client written to back off by
    // Retry-After would read null and either hammer or guess. The value is the small constant, NOT
    // the run-expiry distance: a slot frees when a run finishes (seconds), not when it expires (ten
    // minutes). The expiry distance goes in the body as an upper bound, where over-estimating is
    // context rather than an instruction, and is omitted when the store cannot support a number.
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 429,
      reason: "busy",
    });
    return jsonResponse(
      {
        error: "busy",
        activeRuns: out.activeRuns,
        ...(out.oldestExpiresInSeconds === null
          ? {}
          : { oldestExpiresInSeconds: out.oldestExpiresInSeconds }),
      },
      429,
      { ...rateLimitHeaders(limit), "Retry-After": String(AGENT_BUSY_RETRY_AFTER_SECONDS) },
    );
  }
  recordRejection(ctx, {
    actionType: route.rejectAction,
    tokenFingerprint: fingerprint,
    resultCode: 400,
    reason: "invalid_params",
  });
  return jsonResponse(
    { error: "invalid_params", detail: out.detail },
    400,
    rateLimitHeaders(limit),
  );
}
