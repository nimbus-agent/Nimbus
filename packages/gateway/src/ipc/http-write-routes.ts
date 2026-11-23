import { requireBearer } from "./http-auth.ts";
import type { RateLimitCheck } from "./http-rate-limit.ts";
import { runAgentInvokeRoute } from "./http-write-routes/agents.ts";
import {
  runBriefCreateRoute,
  runBriefRunRoute,
  runBriefSaveRoute,
  runBriefSourceRoute,
} from "./http-write-routes/briefs.ts";
import { runClipIngestRoute, runClipPairConfirmRoute } from "./http-write-routes/clips.ts";
import { AGENT_INVOKE_RE, BRIEF_ITEM_RE, SCIM_ITEM_RE } from "./http-write-routes/constants.ts";
import {
  checkServiceAllowlist,
  extractService,
  runDeploymentRoute,
} from "./http-write-routes/deployment.ts";
import { runItemsFetchRoute } from "./http-write-routes/items-fetch.ts";
import { runPolicyRoute } from "./http-write-routes/policy.ts";
import {
  resolveAgentInvokeRoute,
  resolveBriefCreateRoute,
  resolveBriefItemRoute,
  resolveClipIngestRoute,
  resolveClipPairConfirmRoute,
  resolveDeploymentRoute,
  resolveItemsFetchRoute,
  resolvePolicyRoute,
  resolveScimCreateRoute,
  resolveScimItemRoute,
  resolveTeamsEventsRoute,
} from "./http-write-routes/resolvers.ts";
import {
  jsonResponse,
  notFound,
  rateLimitHeaders,
  recordRejection,
} from "./http-write-routes/responses.ts";
import { runScimRoute } from "./http-write-routes/scim.ts";
import { runTeamsEventsRoute } from "./http-write-routes/teams-events.ts";
import type { ResolvedRoute, WriteRouteContext } from "./http-write-routes/types.ts";

// The allow-list lives in its own module (the I13 enumeration scanned by audit:status-drift);
// this file is the gate: route match, auth, rate limit, body cap, then the handler.
export { ROUTE_ITEMS_FETCH, WRITE_ROUTE_ALLOWLIST } from "./http-write-routes/allowlist.ts";
export type {
  AgentsWriteSurface,
  BriefsWriteSurface,
  ClipsWriteSurface,
  FetchWriteSurface,
  PolicyAuthorResult,
  PolicyWriteSurface,
  ScimWriteSurface,
  TeamsEventsSurface,
  WriteRouteContext,
} from "./http-write-routes/types.ts";

/** Resolves the request to an allowlisted route, or a 404/405 Response. Does NOT consult auth. */
function resolveRoute(req: Request, url: URL, ctx: WriteRouteContext): ResolvedRoute | Response {
  const { method } = req;
  const path = url.pathname;
  if (path === "/v1/deployments") return resolveDeploymentRoute(method, ctx);
  if (path === "/v1/admin/policy") return resolvePolicyRoute(method, ctx);
  if (path === "/scim/v2/Users") return resolveScimCreateRoute(method, ctx);
  if (path === "/v1/messaging/teams/events") return resolveTeamsEventsRoute(method, ctx);
  if (path === "/v1/clips") return resolveClipIngestRoute(method, ctx);
  if (path === "/v1/clips/pair/confirm") return resolveClipPairConfirmRoute(method, ctx);
  if (path === "/v1/briefs") return resolveBriefCreateRoute(method, ctx);
  if (path === "/v1/items/fetch") return resolveItemsFetchRoute(method, ctx);
  const agent = AGENT_INVOKE_RE.exec(path);
  if (agent !== null) return resolveAgentInvokeRoute(method, agent[1] as string, ctx);
  const brief = BRIEF_ITEM_RE.exec(path);
  if (brief !== null) {
    return resolveBriefItemRoute(method, brief[1] as string, brief[2] as string, ctx);
  }
  const item = SCIM_ITEM_RE.exec(path);
  if (item !== null) return resolveScimItemRoute(method, item[1] as string, ctx);
  return notFound();
}

type AuthOk = { fingerprint: string };

function checkAuth(req: Request, route: ResolvedRoute, ctx: WriteRouteContext): Response | AuthOk {
  // The Teams inbound route authenticates with a Bot Framework JWT (validated in-route), not a
  // static bearer — skip requireBearer here; body-cap, rate-limit, and audit still apply.
  if (route.kind === "teamsEvents" || route.kind === "clipPairConfirm") {
    return { fingerprint: route.kind === "teamsEvents" ? "teams-bot" : "clip-pair" };
  }
  // Clip ingest uses a labeled token verified inside runClipIngestRoute (same pattern as teamsEvents).
  if (route.kind === "clipIngest") {
    return { fingerprint: "clip" };
  }
  // Briefs verify the clipper token in-route (clipIngest precedent). The fingerprint doubles as
  // the rate-limit bucket key: source-feeding gets its own bucket so a sweep cannot starve
  // ordinary clipping, and vice versa.
  // Agent invocation verifies the labeled token in-route (clipIngest precedent) and gets its own
  // rate-limit bucket, so an agent sweep cannot starve clipping and vice versa.
  if (route.kind === "agentInvoke") return { fingerprint: "agents" };
  // Targeted fetch verifies the labeled token in-route (clipIngest precedent) and gets its own
  // rate-limit bucket, so a fetch sweep cannot starve clipping/agent invocation and vice versa.
  if (route.kind === "itemsFetch") return { fingerprint: "fetch" };
  if (route.kind === "briefSource") return { fingerprint: "brief-src" };
  if (route.kind === "briefCreate" || route.kind === "briefRun" || route.kind === "briefSave") {
    return { fingerprint: "brief" };
  }
  const auth = requireBearer(req, { expectedToken: route.expectedToken });
  if (auth.surfaceDisabled === true) {
    return jsonResponse({ error: "write_surface_disabled", hint: route.disabledHint }, 503);
  }
  if (!auth.ok) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
      tokenFingerprint: auth.fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return { fingerprint: auth.fingerprint };
}

function checkRateLimit(
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
): Response | RateLimitCheck {
  const limit = ctx.rateLimiter.check(fingerprint, route.maxRequestsPerWindow);
  if (limit.allowed) {
    return limit;
  }
  const retryAfter = Math.max(0, Math.ceil((limit.resetMs - ctx.nowMs()) / 1000));
  recordRejection(ctx, {
    actionType: route.rejectAction,
    tokenFingerprint: fingerprint,
    resultCode: 429,
    reason: "rate_limited",
  });
  return jsonResponse({ error: "rate_limited" }, 429, {
    ...rateLimitHeaders(limit),
    "Retry-After": String(retryAfter),
  });
}

async function parseBody(
  req: Request,
  ctx: WriteRouteContext,
  route: ResolvedRoute,
  fingerprint: string,
  limit: RateLimitCheck,
): Promise<Response | { parsed: unknown }> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader !== null) {
    const n = Number.parseInt(lenHeader, 10);
    if (Number.isInteger(n) && n > route.maxBodyBytes) {
      recordRejection(ctx, {
        actionType: route.rejectAction,
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
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_body",
    });
    return jsonResponse({ error: "invalid_body" }, 400, rateLimitHeaders(limit));
  }
  if (bodyBytes.byteLength > route.maxBodyBytes) {
    recordRejection(ctx, {
      actionType: route.rejectAction,
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
      actionType: route.rejectAction,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_json",
    });
    return jsonResponse({ error: "invalid_json" }, 400, rateLimitHeaders(limit));
  }
}

export async function dispatchWriteRoute(req: Request, ctx: WriteRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const route = resolveRoute(req, url, ctx);
  if (route instanceof Response) {
    return route;
  }

  const auth = checkAuth(req, route, ctx);
  if (auth instanceof Response) {
    return auth;
  }

  const limit = checkRateLimit(ctx, route, auth.fingerprint);
  if (limit instanceof Response) {
    return limit;
  }

  let parsed: unknown;
  if (route.hasBody) {
    const body = await parseBody(req, ctx, route, auth.fingerprint, limit);
    if (body instanceof Response) {
      return body;
    }
    parsed = body.parsed;
  }

  switch (route.kind) {
    case "deployment": {
      const svc = extractService(parsed);
      const svcRes = checkServiceAllowlist(ctx, auth.fingerprint, limit, svc);
      if (svcRes !== undefined) {
        return svcRes;
      }
      return runDeploymentRoute(ctx, auth.fingerprint, limit, parsed, svc);
    }
    case "policy":
      return runPolicyRoute(ctx, auth.fingerprint, limit, parsed);
    case "teamsEvents":
      return runTeamsEventsRoute(ctx, auth.fingerprint, limit, req, parsed);
    case "clipIngest":
      return runClipIngestRoute(ctx, route, auth.fingerprint, limit, req, parsed);
    case "clipPairConfirm":
      return runClipPairConfirmRoute(ctx, auth.fingerprint, limit, parsed);
    case "agentInvoke":
      return runAgentInvokeRoute(ctx, route, auth.fingerprint, limit, req, parsed);
    case "itemsFetch":
      return runItemsFetchRoute(ctx, route, auth.fingerprint, limit, req, parsed);
    case "briefCreate":
      return runBriefCreateRoute(ctx, route, auth.fingerprint, limit, req, parsed);
    case "briefSource":
      return runBriefSourceRoute(ctx, route, auth.fingerprint, limit, req, parsed);
    case "briefRun":
      return runBriefRunRoute(ctx, route, auth.fingerprint, limit, req);
    case "briefSave":
      return runBriefSaveRoute(ctx, route, auth.fingerprint, limit, req);
    default:
      return runScimRoute(ctx, route, auth.fingerprint, limit, parsed);
  }
}

export { tokenFingerprint } from "./http-auth.ts";
