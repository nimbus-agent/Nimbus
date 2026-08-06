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
