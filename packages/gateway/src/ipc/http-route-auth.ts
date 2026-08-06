import type { ApiScope } from "../clips/api-scopes.ts";

/**
 * How one HTTP route is authenticated.
 *
 * There are FOUR distinct credentials on this surface, not one: the labeled client token map
 * (`clip`), the admin token, the SCIM token and the deployment token. Collapsing them into
 * "bearer" would let a scope check appear to cover a route that a different credential guards.
 */
/**
 * Route keys for the two bearer-authed reads that are mounted inline in the `fetch` handler
 * rather than resolved through `dispatchWriteRoute`.
 *
 * Exported as constants because their handlers must look their scope up by key. A literal typed
 * twice — once in the table, once at the call site — is a rename away from silently disagreeing;
 * a constant makes that a compile error.
 */
export const ROUTE_KEY_BRIEF_GET = "GET /v1/briefs/*";
export const ROUTE_KEY_CLIPS_RELATED = "POST /v1/clips/related";

export type RouteAuth =
  | { readonly kind: "public" }
  | { readonly kind: "clip"; readonly scope: ApiScope }
  | { readonly kind: "pairing" }
  | { readonly kind: "admin" }
  | { readonly kind: "scim" }
  | { readonly kind: "deploy" }
  | { readonly kind: "teams" };

/**
 * The auth decision for every route on the local HTTP surface, keyed `"<METHOD> <path>"`.
 *
 * TOTAL over the surface, including the routes that are deliberately unauthenticated. See the
 * completeness test: a new route with no entry here fails the suite rather than inheriting
 * whatever the surrounding code happens to do.
 */
export const HTTP_ROUTE_AUTH: Readonly<Record<string, RouteAuth>> = Object.freeze({
  // --- Unauthenticated reads. Public BY DECISION, recorded so the next one is a decision too.
  "GET /v1/health": { kind: "public" },
  "GET /v1/items": { kind: "public" },
  "GET /v1/items/*": { kind: "public" },
  "GET /v1/connectors": { kind: "public" },
  "GET /v1/people": { kind: "public" },
  "GET /v1/people/*": { kind: "public" },
  "GET /v1/audit": { kind: "public" },
  "GET /v1/metrics/dora": { kind: "public" },
  "GET /v1/preflight/deploy": { kind: "public" },
  "GET /v1/openapi.json": { kind: "public" },

  // --- SCIM-token reads. Matched by `isScimPath(url)` (identity/scim-http-routes.ts), NOT by a
  // literal in http-server.ts — see EXTERNALLY_ROUTED in the test.
  "GET /scim/v2/Users": { kind: "scim" },
  "GET /scim/v2/Users/{id}": { kind: "scim" },

  // --- Admin-token reads.
  "GET /v1/admin/status": { kind: "admin" },
  "GET /metrics": { kind: "admin" },
  "GET /admin": { kind: "admin" },
  "GET /admin/*": { kind: "admin" },

  // --- Client-token reads. Exported constants, NOT bare literals: the two read handlers look
  // their requirement up by these keys, so the table is genuinely the single source of truth.
  [ROUTE_KEY_BRIEF_GET]: { kind: "clip", scope: "briefs" },
  [ROUTE_KEY_CLIPS_RELATED]: { kind: "clip", scope: "clip" },

  // --- Writes. Keys are the `ROUTE_*` constant VALUES from http-write-routes.ts, verbatim.
  // Note `{id}`, not `:id` — copied from source, not guessed.
  "POST /v1/deployments": { kind: "deploy" },
  "POST /scim/v2/Users": { kind: "scim" },
  "PATCH /scim/v2/Users/{id}": { kind: "scim" },
  "DELETE /scim/v2/Users/{id}": { kind: "scim" },
  "PUT /v1/admin/policy": { kind: "admin" },
  "POST /v1/messaging/teams/events": { kind: "teams" },
  "POST /v1/clips": { kind: "clip", scope: "clip" },
  // Gated by the short-lived pairing CODE, not a bearer — it is how a token is obtained, so it
  // cannot require one.
  "POST /v1/clips/pair/confirm": { kind: "pairing" },
  "POST /v1/briefs": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/{id}/sources": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/{id}/run": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/{id}/save": { kind: "clip", scope: "briefs" },
});

export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes(required);
}

/**
 * The scope a clip-token route requires, or null when the route is not clip-authenticated.
 *
 * Every enforcement site calls THIS rather than naming a scope inline. A hardcoded
 * `hasScope(scopes, "briefs")` at a call site would make the table decorative — it would still
 * pass the completeness test while the actual requirement lived somewhere else.
 */
export function clipScopeFor(routeKey: string): ApiScope | null {
  const auth = HTTP_ROUTE_AUTH[routeKey];
  return auth !== undefined && auth.kind === "clip" ? auth.scope : null;
}

export function insufficientScopeBody(
  required: ApiScope,
  granted: readonly ApiScope[],
): { error: string; required: string; granted: string[] } {
  return { error: "insufficient_scope", required, granted: [...granted] };
}

/**
 * Route keys the two inline bearer READS are allowed to pass to `enforceClipScope` /
 * `clipScopeFor`. `requireScopedClipToken` (http-server.ts) only ever calls with one of these two
 * exported constants — narrowing the parameter type to their union makes passing anything else
 * (in particular a raw request path) a compile error rather than a runtime fail-open.
 */
export type ClipReadRouteKey = typeof ROUTE_KEY_CLIPS_RELATED | typeof ROUTE_KEY_BRIEF_GET;

export type ClipScopeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly body: ReturnType<typeof insufficientScopeBody>;
    }
  | {
      readonly ok: false;
      readonly status: 500;
      readonly body: { readonly error: "internal_error" };
    };

/**
 * Enforces a clip-token route's scope requirement, FAIL CLOSED.
 *
 * `routeKey` must already be known by the CALLER to be clip-authenticated — one of the two
 * `ROUTE_KEY_*` read constants, or a write route's `route.key` (the `clipIngest` / `briefCreate` /
 * `briefSource` / `briefRun` / `briefSave` kinds — see `WRITE_ROUTE_ALLOWLIST` in
 * http-write-routes.ts). For such a key, `clipScopeFor` returning `null` does NOT mean "this route
 * needs no scope" — every route this function is called for DOES need one. It means the
 * `HTTP_ROUTE_AUTH` entry for that key was removed, mistyped, or its `kind` was changed away from
 * `"clip"` (e.g. to `"public"`) — a TABLE MISCONFIGURATION, not a legitimately unscoped route.
 * Refuse rather than silently waving the request through unscoped: that silent fall-through is the
 * exact bug this function exists to close (both former call sites read `required !== null` /
 * `required === null` as "no refusal needed", which happened to be true for every entry that
 * exists today but was never actually verified — a flipped or deleted entry sailed straight
 * through).
 *
 * Returns the verdict data only (status + body), not a `Response` — the two callers attach
 * different headers (http-server.ts's inline reads have none extra; http-write-routes.ts's writes
 * carry rate-limit headers), so building the `Response` stays their job.
 */
export function enforceClipScope(routeKey: string, granted: readonly ApiScope[]): ClipScopeVerdict {
  const required = clipScopeFor(routeKey);
  if (required === null) {
    return { ok: false, status: 500, body: { error: "internal_error" } };
  }
  if (!hasScope(granted, required)) {
    return { ok: false, status: 403, body: insufficientScopeBody(required, granted) };
  }
  return { ok: true };
}
