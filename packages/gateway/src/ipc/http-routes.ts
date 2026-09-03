/**
 * Canonical list of the HTTP routes served by `startReadOnlyHttpServer`.
 * The OpenAPI drift CI gate (`scripts/structure-audit/check-openapi-drift.ts`)
 * compares this constant against `packages/gateway/openapi/v1.yaml` so the
 * published schema and the running handler cannot disagree.
 *
 * Adding a route: append here AND add a `paths:` entry in `v1.yaml`. A route
 * that WRITES additionally needs an entry in `WRITE_ROUTE_ALLOWLIST` (I13) —
 * this list is the OpenAPI source of truth, not the write authorization.
 */
export type HttpRoute = {
  readonly method: "GET" | "POST";
  readonly path: string;
};

export const HTTP_ROUTES: readonly HttpRoute[] = Object.freeze([
  { method: "GET", path: "/v1/audit" },
  { method: "GET", path: "/v1/connectors" },
  { method: "POST", path: "/v1/deployments" },
  { method: "GET", path: "/v1/health" },
  { method: "GET", path: "/v1/items" },
  { method: "GET", path: "/v1/items/{id}" },
  { method: "GET", path: "/v1/metrics/dora" },
  { method: "GET", path: "/v1/openapi.json" },
  { method: "GET", path: "/v1/people" },
  { method: "GET", path: "/v1/people/{id}" },
  { method: "GET", path: "/v1/preflight/deploy" },
] as const);
