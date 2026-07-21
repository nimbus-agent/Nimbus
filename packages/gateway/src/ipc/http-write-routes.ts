import type { Database } from "bun:sqlite";
import { ClipValidationError } from "../clips/clip-ingest.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import type { IdentityStore } from "../identity/identity-store.ts";
import { runScimWrite } from "../identity/scim-http-routes.ts";
import { ScimError } from "../identity/scim-service.ts";
import { DeploymentRpcError, dispatchDeploymentRpc } from "./deployment-rpc.ts";
import { bearerToken, requireBearer } from "./http-auth.ts";
import type { HttpWriteRateLimiter, RateLimitCheck } from "./http-rate-limit.ts";

// Canonical allowlist keys ("<METHOD> <PATH>", exact-match for deployment; the `{id}` item routes
// are matched by the SCIM regex below, never by string templating). Plain string literals (no
// backtick templating of `{id}`) so the Opengrep missing-template-string rule can't false-fire.
const ROUTE_DEPLOY = "POST /v1/deployments";
const ROUTE_SCIM_CREATE = "POST /scim/v2/Users";
const ROUTE_SCIM_PATCH = "PATCH /scim/v2/Users/{id}";
const ROUTE_SCIM_DELETE = "DELETE /scim/v2/Users/{id}";
const ROUTE_ADMIN_POLICY = "PUT /v1/admin/policy";
const ROUTE_TEAMS_EVENTS = "POST /v1/messaging/teams/events";
const ROUTE_CLIPS = "POST /v1/clips";
const ROUTE_CLIPS_PAIR_CONFIRM = "POST /v1/clips/pair/confirm";

/**
 * The complete HTTP write surface (I13). Every entry flows through `dispatchWriteRoute` — bearer
 * auth, per-token rate-limit, body cap, and audit-on-rejection. `POST /v1/deployments` is the CI
 * deploy-annotation route; the three `/scim/v2/Users` routes are the SCIM provisioning surface
 * (own bearer = `identity.scim.bearer`); `PUT /v1/admin/policy` is the admin-console anchor policy
 * write surface (own bearer = the admin token; signs the org policy with the Vault-only anchor key);
 * `POST /v1/messaging/teams/events` is the ChatOps Teams inbound surface (auth = a Bot Framework
 * JWT validated in-route, not a static bearer). `POST /v1/clips` is the web-clipper ingest surface
 * (auth = a labeled clip token validated in-route); `POST /v1/clips/pair/confirm` is the pairing
 * confirm surface (gated by a short-lived pairing code). No other HTTP method may write.
 */
export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([
  ROUTE_DEPLOY,
  ROUTE_SCIM_CREATE,
  ROUTE_SCIM_PATCH,
  ROUTE_SCIM_DELETE,
  ROUTE_ADMIN_POLICY,
  ROUTE_TEAMS_EVENTS,
  ROUTE_CLIPS,
  ROUTE_CLIPS_PAIR_CONFIRM,
]);

const SCIM_ITEM_RE = /^\/scim\/v2\/Users\/([^/]+)$/;
/**
 * Per-route request-body cap (enforced in `parseBody`, twice: on the `content-length` header
 * before the body is read, and again on the actual byte length).
 *
 * `MAX_BODY_BYTES_DEFAULT` (8 KiB) is the anti-abuse bound for the control-plane routes this
 * dispatcher was built for — deploy annotations, SCIM user records, the admin policy TOML, Teams
 * activities, and the clip pairing confirm (a `{code}` body of a few dozen bytes). Keep it.
 *
 * `MAX_BODY_BYTES_CLIP` (1 MiB) applies ONLY to `POST /v1/clips`, which carries the readable text
 * of a whole web page — real articles routinely exceed 8 KiB, so the shared cap made the web
 * clipper unusable (413 payload_too_large on every non-trivial page; issue #771). Do NOT unify
 * these back into one constant: the clip route is the outlier, and widening the control-plane
 * routes to 1 MiB would give away a cheap abuse bound for nothing.
 */
const MAX_BODY_BYTES_DEFAULT = 8 * 1024;
const MAX_BODY_BYTES_CLIP = 1024 * 1024;

/**
 * Per-route request rate cap (per token fingerprint, per rate-limiter window; it may only tighten
 * the server-configured limit, never loosen it — see `HttpWriteRateLimiter.check`).
 *
 * `MAX_REQUESTS_PER_WINDOW_DEFAULT` (60/min) is the shared control-plane limit.
 *
 * `MAX_REQUESTS_PER_WINDOW_CLIP` (20/min) is the tightening that pays for `MAX_BODY_BYTES_CLIP`:
 * raising a body cap without tightening the matching rate limit is exactly what the write-surface
 * playbook forbids, because the abuse bound is cap × rate. 60 × 1 MiB/min would have been a ~60
 * MiB/min burst; 20 × 1 MiB/min holds it to ~20 MiB/min while staying generous for a human
 * clipping pages. Keep these two constants moving together.
 *
 * This matters more than for the other routes: `checkAuth` returns a constant fingerprint for
 * `clipIngest` WITHOUT verifying the token — the clip token is checked inside `runClipIngestRoute`,
 * i.e. after `parseBody` has already buffered, UTF-8 decoded, and JSON-parsed the body. So for this
 * route the body cap and this rate limit are the only bounds on pre-auth work. That is acceptable
 * on a loopback-only surface at 1 MiB; it is the reason the pair is deliberately conservative.
 */
const MAX_REQUESTS_PER_WINDOW_DEFAULT = 60;
const MAX_REQUESTS_PER_WINDOW_CLIP = 20;

const DEPLOY_DISABLED_HINT =
  "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token <value>'";
const SCIM_DISABLED_HINT = "set identity.scim.bearer via 'nimbus identity scim set-token <value>'";

const DEPLOY_REJECT_ACTION = "deployment.annotation_rejected";
const SCIM_REJECT_ACTION = "scim.provision_rejected";
const POLICY_DISABLED_HINT =
  "policy write surface disabled — set the bearer via 'nimbus vault set http_api.deployment_token <value>'";
const POLICY_REJECT_ACTION = "policy.applied_rejected";
const TEAMS_EVENTS_DISABLED_HINT =
  "ChatOps Teams surface disabled — enable [chatops].teams_enabled";
const TEAMS_EVENTS_REJECT_ACTION = "messaging.teams.inbound_rejected";
const CLIP_DISABLED_HINT = "web clipper disabled — pair a browser with 'nimbus clip pair'";
const CLIP_REJECT_ACTION = "clip.ingest_rejected";
const CLIP_PAIR_REJECT_ACTION = "clip.pair_rejected";

/** SCIM seam — present only when the SCIM provisioning surface is enabled for this server. */
export interface ScimWriteSurface {
  readonly token: string;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
}

/** Result of the anchor policy author closure (mirrors policy/policy-author.ts AuthorResult). */
export type PolicyAuthorResult =
  | { ok: true; bundle: { toml: string; sig: string }; org: string; version: number }
  | { ok: false; error: string };

/**
 * Anchor policy write seam — present only when the admin policy surface is enabled. `authorPolicy`
 * validates+signs (Vault-only anchor key)+persists+applies the submitted org-policy TOML; it lives
 * under `policy/` so D16 (parsePolicyToml import scoping) is respected — this route never parses TOML.
 */
export interface PolicyWriteSurface {
  readonly token: string;
  readonly authorPolicy: (toml: string) => Promise<PolicyAuthorResult>;
}

/**
 * ChatOps Teams inbound seam — present only when the ChatOps Teams surface is enabled. Auth is a
 * Bot Framework JWT (validated in-route against the Bot Framework JWKS), NOT a static bearer; the
 * `validateBotJwt` closure reuses the identity JWKS-cache + RS256 verifier and checks `aud ===
 * teamsBotAppId`. `onActivity` hands the raw activity to the ChatOps service (normalize → route).
 */
export interface TeamsEventsSurface {
  readonly teamsBotAppId: string;
  readonly validateBotJwt: (authorizationHeader: string | null, nowMs: number) => Promise<boolean>;
  readonly onActivity: (activity: unknown) => Promise<void>;
}

/**
 * Web-clipper seam — present only when the clip surface is enabled. Token verification and minting
 * are injected so this route layer never touches the Vault or token store directly.
 */
export interface ClipsWriteSurface {
  readonly pairing: PairingWindowController;
  readonly verifyToken: (presented: string) => Promise<{ label: string } | null>;
  readonly mintToken: (label: string) => Promise<string>;
  readonly ingest: (input: unknown) => { id: string; status: "created" | "updated" };
}

export interface WriteRouteContext {
  readonly writeDb: Database;
  readonly expectedToken: string;
  readonly rateLimiter: HttpWriteRateLimiter;
  readonly nowMs: () => number;
  readonly deployEnvironments?: readonly string[];
  readonly knownServices: () => readonly string[];
  readonly scim?: ScimWriteSurface;
  readonly policy?: PolicyWriteSurface;
  readonly messaging?: TeamsEventsSurface;
  readonly clips?: ClipsWriteSurface;
}

type RouteKind =
  | "deployment"
  | "scim"
  | "policy"
  | "teamsEvents"
  | "clipIngest"
  | "clipPairConfirm";

interface ResolvedRoute {
  readonly key: string;
  readonly kind: RouteKind;
  readonly expectedToken: string;
  readonly disabledHint: string;
  readonly rejectAction: string;
  readonly hasBody: boolean;
  /** Request-body cap for THIS route (see MAX_BODY_BYTES_DEFAULT / MAX_BODY_BYTES_CLIP). */
  readonly maxBodyBytes: number;
  /**
   * Requests per rate-limit window for THIS route (see MAX_REQUESTS_PER_WINDOW_DEFAULT /
   * MAX_REQUESTS_PER_WINDOW_CLIP). Tightens the server-configured limit; never loosens it.
   */
  readonly maxRequestsPerWindow: number;
  readonly id?: string;
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

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
}

function recordRejection(
  ctx: WriteRouteContext,
  args: {
    readonly actionType: string;
    readonly tokenFingerprint: string;
    readonly resultCode: number;
    readonly reason: string;
    readonly externalId?: string;
    readonly service?: string;
  },
): void {
  try {
    appendAuditEntry(ctx.writeDb, {
      actionType: args.actionType,
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

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** `POST /v1/deployments` (always-on surface; bearer = `http_api.deployment_token`). */
function resolveDeploymentRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
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
function resolvePolicyRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
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
function resolveScimCreateRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
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
function resolveTeamsEventsRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
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
function resolveScimItemRoute(
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
function resolveClipIngestRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
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
    maxBodyBytes: MAX_BODY_BYTES_CLIP,
    // The raised cap is paid for with a tighter rate limit (see the constants above).
    maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW_CLIP,
  };
}

/** `POST /v1/clips/pair/confirm` (404 unless the clips seam is enabled). */
function resolveClipPairConfirmRoute(
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

/** Maps a SCIM HTTP status to the audit `reason` tag. */
function scimReason(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "scim_error";
}

/** Re-attaches the rate-limit headers to a SCIM handler Response without consuming its body. */
function withRateLimitHeaders(res: Response, limit: RateLimitCheck): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(rateLimitHeaders(limit))) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

async function runScimRoute(
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

/** Extracts a string `toml` field from the parsed body, or undefined if missing/wrong type. */
function extractToml(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "toml" in parsed) {
    const t = (parsed as { toml?: unknown }).toml;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

async function runPolicyRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.policy is defined for every policy-kind route.
  const policy = ctx.policy as PolicyWriteSurface;
  const toml = extractToml(parsed);
  if (toml === undefined) {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_body",
    });
    return jsonResponse({ error: "invalid_body", detail: "body.toml (string) is required" }, 400, {
      ...rateLimitHeaders(limit),
    });
  }
  let result: PolicyAuthorResult;
  try {
    result = await policy.authorPolicy(toml);
  } catch {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
  if (!result.ok) {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_policy",
    });
    return jsonResponse({ error: result.error }, 400, rateLimitHeaders(limit));
  }
  // The privkey is NEVER in the response — only the applied org/version summary (the {toml, sig}
  // bundle is public, but the response intentionally returns just the applied summary).
  return jsonResponse(
    { data: { applied: true, org: result.org, version: result.version } },
    200,
    rateLimitHeaders(limit),
  );
}

async function runTeamsEventsRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.messaging is defined for every teamsEvents-kind route.
  const messaging = ctx.messaging as TeamsEventsSurface;
  let valid: boolean;
  try {
    valid = await messaging.validateBotJwt(req.headers.get("authorization"), ctx.nowMs());
  } catch {
    valid = false; // fail closed on any verifier error (e.g. JWKS unreachable on cold start)
  }
  if (!valid) {
    recordRejection(ctx, {
      actionType: TEAMS_EVENTS_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "invalid_bot_jwt",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  try {
    await messaging.onActivity(parsed);
    return jsonResponse({ ok: true }, 200, rateLimitHeaders(limit));
  } catch {
    recordRejection(ctx, {
      actionType: TEAMS_EVENTS_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}

async function runClipIngestRoute(
  ctx: WriteRouteContext,
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

function extractCode(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "code" in parsed) {
    const c = (parsed as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function runClipPairConfirmRoute(
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
  const token = await clips.mintToken(confirmed.label);
  return jsonResponse({ token, label: confirmed.label }, 200, rateLimitHeaders(limit));
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

  if (route.kind === "deployment") {
    const svc = extractService(parsed);
    const svcRes = checkServiceAllowlist(ctx, auth.fingerprint, limit, svc);
    if (svcRes !== undefined) {
      return svcRes;
    }
    return runDeploymentRoute(ctx, auth.fingerprint, limit, parsed, svc);
  }
  if (route.kind === "policy") {
    return runPolicyRoute(ctx, auth.fingerprint, limit, parsed);
  }
  if (route.kind === "teamsEvents") {
    return runTeamsEventsRoute(ctx, auth.fingerprint, limit, req, parsed);
  }
  if (route.kind === "clipIngest") {
    return runClipIngestRoute(ctx, auth.fingerprint, limit, req, parsed);
  }
  if (route.kind === "clipPairConfirm") {
    return runClipPairConfirmRoute(ctx, auth.fingerprint, limit, parsed);
  }
  return runScimRoute(ctx, route, auth.fingerprint, limit, parsed);
}

export { tokenFingerprint } from "./http-auth.ts";
