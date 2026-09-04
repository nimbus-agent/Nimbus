/**
 * The routes the OpenAPI schema is checked against — NOT every route the server serves.
 *
 * `scripts/structure-audit/check-openapi-drift.ts` compares this constant against
 * `packages/gateway/openapi/v1.yaml` so the published schema and the running handler
 * cannot disagree about the routes listed HERE.
 *
 * The scope bound is load-bearing and easy to overstate: `startReadOnlyHttpServer` also
 * dispatches POST/PUT/PATCH/DELETE to `dispatchWriteRoute`, and `WRITE_ROUTE_ALLOWLIST`
 * (I13) carries considerably more write routes than the single `POST /v1/deployments`
 * documented here. Those are authorized and audited by I13, not by this list, and the
 * drift gate does not see them. Read a green `audit:openapi-drift` as "the documented
 * surface matches the schema", never as "every served route is in the schema".
 *
 * Adding a route: append here AND add a `paths:` entry in `v1.yaml`. A route that WRITES
 * additionally needs a `WRITE_ROUTE_ALLOWLIST` entry — this list is the OpenAPI source of
 * truth, not the write authorization.
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
