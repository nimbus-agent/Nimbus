import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "./openapi-indexer-parsing.ts";

const FIX = join(import.meta.dir, "..", "..", "test", "fixtures", "openapi");

async function parseFixture(name: string) {
  const path = join(FIX, name);
  const bytes = readFileSync(path, "utf8");
  return parseSpec({ absPath: path, source: bytes, maxBytes: 5 * 1024 * 1024 });
}

test("OpenAPI 3.0 — extracts endpoints with operationId, tags, deprecated", async () => {
  const r = await parseFixture("petstore-3.0.yaml");
  if (r.kind === "skipped") {
    throw new Error(`should not skip: ${r.reason}`);
  }
  const eps = r.endpoints;
  expect(eps.length).toBe(2);
  const list = eps.find((e) => e.method === "GET" && e.path === "/pets");
  expect(list?.operationId).toBe("listPets");
  expect(list?.tags).toEqual(["pets"]);
  expect(list?.deprecated).toBe(false);
  const del = eps.find((e) => e.method === "DELETE" && e.path === "/pets/{id}");
  expect(del?.deprecated).toBe(true);
  expect(r.specVersion).toBe("openapi-3.0.0");
  expect(r.infoTitle).toBe("Petstore API");
});

test("OpenAPI 3.1 fixture parses", async () => {
  const r = await parseFixture("petstore-3.1.yaml");
  if (r.kind === "skipped") throw new Error(r.reason);
  expect(r.endpoints.length).toBe(1);
  expect(r.specVersion).toBe("openapi-3.1.0");
});

test("Swagger 2.0 fixture parses", async () => {
  const r = await parseFixture("petstore-2.0.json");
  if (r.kind === "skipped") throw new Error(r.reason);
  expect(r.endpoints.length).toBe(1);
  expect(r.specVersion).toBe("swagger-2.0");
});

test("AsyncAPI 2.6 — exposes PUBLISH and SUBSCRIBE methods on a channel", async () => {
  const r = await parseFixture("asyncapi-2.6.yaml");
  if (r.kind === "skipped") throw new Error(r.reason);
  const methods = r.endpoints.map((e) => e.method).sort();
  expect(methods).toEqual(["PUBLISH", "SUBSCRIBE"]);
  expect(r.specVersion).toBe("asyncapi-2.6.0");
});

test("invalid YAML is skipped with reason 'parse_failed'", async () => {
  const r = await parseFixture("bad-yaml.yaml");
  expect(r.kind).toBe("skipped");
  if (r.kind === "skipped") {
    expect(r.reason).toBe("parse_failed");
  }
});

test("YAML that is not a spec is skipped with reason 'not_a_spec'", async () => {
  const r = await parseFixture("not-a-spec.yaml");
  expect(r.kind).toBe("skipped");
  if (r.kind === "skipped") {
    expect(r.reason).toBe("not_a_spec");
  }
});

test("unresolvable internal $ref does not crash; broken endpoints still surface", async () => {
  const r = await parseFixture("unresolvable-ref.yaml");
  if (r.kind === "skipped") throw new Error(`should not skip: ${r.reason}`);
  expect(r.endpoints.length).toBe(1);
  expect(r.endpoints[0]?.path).toBe("/broken");
});

test("webhook-only OpenAPI 3.1 yields zero endpoints (paths missing) but does not throw", async () => {
  const r = await parseFixture("webhook-only-3.1.yaml");
  if (r.kind === "skipped") {
    return;
  }
  expect(r.endpoints.length).toBe(0);
});

test("oversize spec is skipped with reason 'too_large'", () => {
  const big = "x".repeat(5);
  const r = parseSpec({ absPath: "/tmp/big.yaml", source: big, maxBytes: 4 });
  expect(r.kind).toBe("skipped");
  if (r.kind === "skipped") {
    expect(r.reason).toBe("too_large");
  }
});
