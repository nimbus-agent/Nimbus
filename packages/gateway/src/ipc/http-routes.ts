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

export const READ_ONLY_HTTP_ROUTES = HTTP_ROUTES;

export type ReadOnlyHttpRoute = HttpRoute;
