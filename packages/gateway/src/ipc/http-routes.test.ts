import { describe, expect, it } from "bun:test";
import { HTTP_ROUTES } from "./http-routes.ts";

describe("HTTP_ROUTES", () => {
  it("includes the canonical read-only endpoints plus POST /v1/deployments", () => {
    const keys = HTTP_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual([
      "GET /v1/audit",
      "GET /v1/connectors",
      "POST /v1/deployments",
      "GET /v1/health",
      "GET /v1/items",
      "GET /v1/items/{id}",
      "GET /v1/metrics/dora",
      "GET /v1/openapi.json",
      "GET /v1/people",
      "GET /v1/people/{id}",
      "GET /v1/preflight/deploy",
    ]);
  });

  it("declares every route as either GET or POST", () => {
    for (const route of HTTP_ROUTES) {
      expect(["GET", "POST"]).toContain(route.method);
    }
  });

  it("contains exactly one POST entry (POST /v1/deployments)", () => {
    const posts = HTTP_ROUTES.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ method: "POST", path: "/v1/deployments" });
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(HTTP_ROUTES)).toBe(true);
  });
});
