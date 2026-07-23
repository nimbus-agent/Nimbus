import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTTP_ROUTES } from "../../packages/gateway/src/ipc/http-routes.ts";
import { findOpenApiDrift } from "./check-openapi-drift.ts";

function tmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-drift-"));
  const p = join(dir, "v1.yaml");
  writeFileSync(p, content, "utf8");
  return p;
}

describe("findOpenApiDrift", () => {
  it("returns no issues when YAML and ROUTE_TABLE agree", () => {
    const pathsBlock = HTTP_ROUTES.map(
      (r) =>
        `  ${r.path}:\n    ${r.method.toLowerCase()}:\n      responses:\n        "200":\n          description: ok`,
    ).join("\n");
    const yaml = `openapi: 3.1.0\ninfo:\n  title: t\n  version: 1.0.0\npaths:\n${pathsBlock}\n`;
    const file = tmpYaml(yaml);
    const issues = findOpenApiDrift(file, HTTP_ROUTES);
    expect(issues).toEqual([]);
  });

  it("reports a schema-without-handler entry", () => {
    const yaml = `openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /v1/health: { get: { responses: { "200": { description: ok } } } }
  /v1/ghost:  { get: { responses: { "200": { description: ok } } } }
`;
    const file = tmpYaml(yaml);
    const routes = [{ method: "GET" as const, path: "/v1/health" }];
    const issues = findOpenApiDrift(file, routes);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    if (!issue) throw new Error("expected one drift issue");
    expect(issue.kind).toBe("schema_without_handler");
    expect(issue.path).toBe("/v1/ghost");
  });

  it("reports a handler-without-schema entry", () => {
    const yaml = `openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /v1/health: { get: { responses: { "200": { description: ok } } } }
`;
    const file = tmpYaml(yaml);
    const routes = [
      { method: "GET" as const, path: "/v1/health" },
      { method: "GET" as const, path: "/v1/orphan" },
    ];
    const issues = findOpenApiDrift(file, routes);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    if (!issue) throw new Error("expected one drift issue");
    expect(issue.kind).toBe("handler_without_schema");
    expect(issue.path).toBe("/v1/orphan");
  });

  it("exempts paths with x-nimbus-status: reserved from handler check", () => {
    const yaml = `openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /v1/health: { get: { responses: { "200": { description: ok } } } }
  /v1/metrics/dora:
    x-nimbus-status: reserved
    description: reserved for PR 2
`;
    const file = tmpYaml(yaml);
    const routes = [{ method: "GET" as const, path: "/v1/health" }];
    const issues = findOpenApiDrift(file, routes);
    expect(issues).toEqual([]);
  });

  it("reports a method mismatch (POST in schema, GET in handler)", () => {
    const yaml = `openapi: 3.1.0
info: { title: t, version: 1.0.0 }
paths:
  /v1/health: { post: { responses: { "200": { description: ok } } } }
`;
    const file = tmpYaml(yaml);
    const routes = [{ method: "GET" as const, path: "/v1/health" }];
    const issues = findOpenApiDrift(file, routes);
    expect(issues.length).toBeGreaterThan(0);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("schema_without_handler");
    expect(kinds).toContain("handler_without_schema");
  });
});
