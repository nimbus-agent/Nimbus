import {
  ROUTE_ADMIN_POLICY,
  ROUTE_AGENT_INVOKE,
  ROUTE_BRIEF_RUN,
  ROUTE_BRIEF_SAVE,
  ROUTE_BRIEF_SOURCES,
  ROUTE_BRIEFS,
  ROUTE_CLIPS,
  ROUTE_CLIPS_PAIR_CONFIRM,
  ROUTE_DEPLOY,
  ROUTE_ITEMS_FETCH,
  ROUTE_SCIM_CREATE,
  ROUTE_SCIM_DELETE,
  ROUTE_SCIM_PATCH,
  ROUTE_TEAMS_EVENTS,
} from "./allowlist.ts";
import {
  AGENT_INVOKE_REJECT_ACTION,
  AGENTS_DISABLED_HINT,
  BRIEF_CREATE_REJECT_ACTION,
  BRIEF_DISABLED_HINT,
  BRIEF_RUN_REJECT_ACTION,
  BRIEF_SAVE_REJECT_ACTION,
  BRIEF_SOURCE_REJECT_ACTION,
  CLIP_DISABLED_HINT,
  CLIP_PAIR_REJECT_ACTION,
  CLIP_REJECT_ACTION,
  DEPLOY_DISABLED_HINT,
  DEPLOY_REJECT_ACTION,
  ITEMS_FETCH_DISABLED_HINT,
  ITEMS_FETCH_REJECT_ACTION,
  MAX_BODY_BYTES_ARTICLE,
  MAX_BODY_BYTES_BRIEF_CREATE,
  MAX_BODY_BYTES_DEFAULT,
  MAX_REQUESTS_PER_WINDOW_BRIEF_SOURCE,
  MAX_REQUESTS_PER_WINDOW_CLIP,
  MAX_REQUESTS_PER_WINDOW_DEFAULT,
  POLICY_DISABLED_HINT,
  POLICY_REJECT_ACTION,
  SCIM_DISABLED_HINT,
  SCIM_REJECT_ACTION,
  TEAMS_EVENTS_DISABLED_HINT,
  TEAMS_EVENTS_REJECT_ACTION,
} from "./constants.ts";
import { briefsDisabled, jsonResponse, methodNotAllowed, notFound } from "./responses.ts";
import type { ResolvedRoute, WriteRouteContext } from "./types.ts";

/** `POST /v1/deployments` (always-on surface; bearer = `http_api.deployment_token`). */
export function resolveDeploymentRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  return {
    key: ROUTE_DEPLOY,
    kind: "deployment",
    expectedToken: ctx.expectedToken,
    disabledHint: DEPLOY_DISABLED_HINT,
    rejectAction: DEPLOY_REJECT_ACTION,
    hasBody: true,
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `PUT /v1/admin/policy` (404 unless the policy seam is enabled). */
export function resolvePolicyRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "PUT") return methodNotAllowed("PUT");
  if (ctx.policy === undefined) return notFound();
  return {
    key: ROUTE_ADMIN_POLICY,
    kind: "policy",
    expectedToken: ctx.policy.token,
    disabledHint: POLICY_DISABLED_HINT,
    rejectAction: POLICY_REJECT_ACTION,
    hasBody: true,
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `POST /scim/v2/Users` (404 unless the SCIM seam is enabled). */
export function resolveScimCreateRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.scim === undefined) return notFound();
  return {
    key: ROUTE_SCIM_CREATE,
    kind: "scim",
    expectedToken: ctx.scim.token,
    disabledHint: SCIM_DISABLED_HINT,
    rejectAction: SCIM_REJECT_ACTION,
    hasBody: true,
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `POST /v1/messaging/teams/events` (404 unless the ChatOps Teams seam is enabled). */
export function resolveTeamsEventsRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.messaging === undefined) return notFound();
  return {
    key: ROUTE_TEAMS_EVENTS,
    kind: "teamsEvents",
    // Auth is the Bot Framework JWT (validated in runTeamsEventsRoute); no static bearer.
    expectedToken: "",
    disabledHint: TEAMS_EVENTS_DISABLED_HINT,
    rejectAction: TEAMS_EVENTS_REJECT_ACTION,
    hasBody: true,
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `PATCH|DELETE /scim/v2/Users/{id}` (404 unless the SCIM seam is enabled). */
export function resolveScimItemRoute(
  method: string,
  id: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed("PATCH, DELETE");
  if (ctx.scim === undefined) return notFound();
  return {
    key: method === "PATCH" ? ROUTE_SCIM_PATCH : ROUTE_SCIM_DELETE,
    kind: "scim",
    expectedToken: ctx.scim.token,
    disabledHint: SCIM_DISABLED_HINT,
    rejectAction: SCIM_REJECT_ACTION,
    hasBody: method === "PATCH",
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
    id,
  };
}

/** `POST /v1/clips` (404 unless the clips seam is enabled). */
export function resolveClipIngestRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.clips === undefined) return notFound();
  return {
    key: ROUTE_CLIPS,
    kind: "clipIngest",
    expectedToken: "", // verified in-route against the labeled token map (teamsEvents precedent)
    disabledHint: CLIP_DISABLED_HINT,
    rejectAction: CLIP_REJECT_ACTION,
    hasBody: true,
    // A clip body is a whole readable article, not a control-plane payload (#771).
    maxBodyBytes: MAX_BODY_BYTES_ARTICLE,
    // The raised cap is paid for with a tighter rate limit (see the constants above).
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_CLIP,
  };
}

/** `POST /v1/clips/pair/confirm` (404 unless the clips seam is enabled). */
export function resolveClipPairConfirmRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.clips === undefined) return notFound();
  return {
    key: ROUTE_CLIPS_PAIR_CONFIRM,
    kind: "clipPairConfirm",
    expectedToken: "", // gated by the pairing code, not a bearer
    disabledHint: CLIP_DISABLED_HINT,
    rejectAction: CLIP_PAIR_REJECT_ACTION,
    hasBody: true,
    // A pairing confirm is a tiny {code} body — it keeps the control-plane cap.
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `POST /v1/agents/{agent}` (404 unless the agents seam is enabled). */
export function resolveAgentInvokeRoute(
  method: string,
  agent: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.agents === undefined) {
    return jsonResponse({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT }, 404);
  }
  return {
    key: ROUTE_AGENT_INVOKE,
    kind: "agentInvoke",
    expectedToken: "", // verified in-route against the labeled token map (clipIngest precedent)
    disabledHint: AGENTS_DISABLED_HINT,
    rejectAction: AGENT_INVOKE_REJECT_ACTION,
    hasBody: true,
    // Control-plane sized. Agent params are a topic, a file path or a since-window; the 1 MiB
    // article cap stays the deliberate outlier it is documented to be.
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
    // `id` carries the agent NAME for this route kind, as it carries the brief id for the brief
    // routes. The route KEY stays the static template either way.
    id: agent,
  };
}

/** 404 that names the cause, matching briefsDisabled()/agentsDisabled()'s shape. */
export function itemsFetchDisabled(): Response {
  return jsonResponse({ error: "fetch_disabled", hint: ITEMS_FETCH_DISABLED_HINT }, 404);
}

/** `POST /v1/items/fetch` (404 unless the targeted-fetch seam is enabled). */
export function resolveItemsFetchRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.fetch === undefined) return itemsFetchDisabled();
  return {
    key: ROUTE_ITEMS_FETCH,
    kind: "itemsFetch",
    expectedToken: "", // verified in-route against the clipper token map (clipIngest precedent)
    disabledHint: ITEMS_FETCH_DISABLED_HINT,
    rejectAction: ITEMS_FETCH_REJECT_ACTION,
    hasBody: true,
    // Control-plane sized: the body is a single URL, not an article. Do NOT reuse
    // MAX_BODY_BYTES_ARTICLE — a URL is control-plane data, not extracted page content.
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `POST /v1/briefs` (404 unless the briefs seam is enabled). */
export function resolveBriefCreateRoute(
  method: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.briefs === undefined) return briefsDisabled();
  return {
    key: ROUTE_BRIEFS,
    kind: "briefCreate",
    expectedToken: "", // verified in-route against the clipper token map (clipIngest precedent)
    disabledHint: BRIEF_DISABLED_HINT,
    rejectAction: BRIEF_CREATE_REJECT_ACTION,
    hasBody: true,
    // NOT the 8 KiB control-plane default: see MAX_BODY_BYTES_BRIEF_CREATE.
    maxBodyBytes: MAX_BODY_BYTES_BRIEF_CREATE,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
  };
}

/** `POST /v1/briefs/{id}/{sources|run|save}`. */
export function resolveBriefItemRoute(
  method: string,
  id: string,
  action: string,
  ctx: WriteRouteContext,
): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.briefs === undefined) return briefsDisabled();
  if (action === "sources") {
    return {
      key: ROUTE_BRIEF_SOURCES,
      kind: "briefSource",
      expectedToken: "",
      disabledHint: BRIEF_DISABLED_HINT,
      rejectAction: BRIEF_SOURCE_REJECT_ACTION,
      hasBody: true,
      // A whole extracted article, exactly like a clip body — same constant.
      maxBodyBytes: MAX_BODY_BYTES_ARTICLE,
      maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_BRIEF_SOURCE,
      id,
    };
  }
  const isRun = action === "run";
  return {
    key: isRun ? ROUTE_BRIEF_RUN : ROUTE_BRIEF_SAVE,
    kind: isRun ? "briefRun" : "briefSave",
    expectedToken: "",
    disabledHint: BRIEF_DISABLED_HINT,
    rejectAction: isRun ? BRIEF_RUN_REJECT_ACTION : BRIEF_SAVE_REJECT_ACTION,
    hasBody: false,
    maxBodyBytes: MAX_BODY_BYTES_DEFAULT,
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_DEFAULT,
    id,
  };
}
