import { describe, expect, test } from "bun:test";
import { type LoadDeps, loadOpenApiDocument, MAX_OPENAPI_BYTES, OpenApiLoadError } from "./load.ts";

const enc = new TextEncoder();

function depsFor(files: Record<string, string | Uint8Array>, fetchImpl?: typeof fetch): LoadDeps {
  return {
    fetch:
      fetchImpl ??
      ((async () => {
        throw new Error("fetch must not be called");
      }) as unknown as typeof fetch),
    readFile: async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return typeof v === "string" ? enc.encode(v) : v;
    },
    now: () => 0,
  };
}

async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected rejection");
}

function fetchReturning(make: () => Response): typeof fetch {
  return (async () => make()) as unknown as typeof fetch;
}

describe("loadOpenApiDocument", () => {
  test("parses a JSON file", async () => {
    const doc = await loadOpenApiDocument(
      "a.json",
      depsFor({ "a.json": '{"openapi":"3.0.3","paths":{}}' }),
    );
    expect(doc["openapi"]).toBe("3.0.3");
  });

  test("parses a YAML file and strips a BOM", async () => {
    const doc = await loadOpenApiDocument(
      "a.yaml",
      depsFor({ "a.yaml": "﻿openapi: 3.1.0\npaths: {}\n" }),
    );
    expect(doc["openapi"]).toBe("3.1.0");
  });

  test("flow-style YAML starting with { parses", async () => {
    const doc = await loadOpenApiDocument(
      "a.yaml",
      depsFor({ "a.yaml": "{openapi: '3.0.0', paths: {}}" }),
    );
    expect(doc["openapi"]).toBe("3.0.0");
  });

  test("Swagger 2.0 is refused", async () => {
    const e = await rejectionOf(
      loadOpenApiDocument("s.json", depsFor({ "s.json": '{"swagger":"2.0"}' })),
    );
    expect(e).toBeInstanceOf(OpenApiLoadError);
    expect(e.message).toBe(
      "Swagger 2.0 is not supported; convert it to OpenAPI 3 first (for example with swagger2openapi)",
    );
  });

  test("another openapi version is refused", async () => {
    const e = await rejectionOf(
      loadOpenApiDocument("a.json", depsFor({ "a.json": '{"openapi":"4.0.0"}' })),
    );
    expect(e.message).toBe("OpenAPI 4.0.0 is not supported; use 3.0 or 3.1");
  });

  test("a non-object is refused", async () => {
    const e = await rejectionOf(loadOpenApiDocument("a.yaml", depsFor({ "a.yaml": "- 1\n- 2\n" })));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("a missing openapi field is refused", async () => {
    const e = await rejectionOf(
      loadOpenApiDocument("a.json", depsFor({ "a.json": '{"info":{}}' })),
    );
    expect(e).toBeInstanceOf(OpenApiLoadError);
    expect(e.message).toContain("openapi");
  });

  test("http:// is refused without calling fetch", async () => {
    const e = await rejectionOf(loadOpenApiDocument("http://x.test/a.json", depsFor({})));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("another scheme is refused", async () => {
    const e = await rejectionOf(loadOpenApiDocument("ftp://x.test/a.json", depsFor({})));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("fetches an https URL", async () => {
    const f = fetchReturning(() => new Response('{"openapi":"3.0.1"}', { status: 200 }));
    const doc = await loadOpenApiDocument("https://x.test/a.json", depsFor({}, f));
    expect(doc["openapi"]).toBe("3.0.1");
  });

  test("follows up to 5 redirects", async () => {
    let n = 0;
    const f = fetchReturning(() => {
      n += 1;
      if (n <= 5) {
        return new Response(null, { status: 302, headers: { location: `https://x.test/${n}` } });
      }
      return new Response('{"openapi":"3.0.1"}', { status: 200 });
    });
    const doc = await loadOpenApiDocument("https://x.test/a", depsFor({}, f));
    expect(doc["openapi"]).toBe("3.0.1");
  });

  test("a chain of 6 redirects is refused", async () => {
    const f = fetchReturning(
      () => new Response(null, { status: 302, headers: { location: "https://x.test/n" } }),
    );
    const e = await rejectionOf(loadOpenApiDocument("https://x.test/a", depsFor({}, f)));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("a redirect to http: is refused", async () => {
    const f = fetchReturning(
      () => new Response(null, { status: 301, headers: { location: "http://x.test/a" } }),
    );
    const e = await rejectionOf(loadOpenApiDocument("https://x.test/a", depsFor({}, f)));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("a non-2xx status is refused", async () => {
    const f = fetchReturning(() => new Response("no", { status: 404 }));
    const e = await rejectionOf(loadOpenApiDocument("https://x.test/a", depsFor({}, f)));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("a body past the cap is refused", async () => {
    const f = fetchReturning(
      () => new Response(new Uint8Array(MAX_OPENAPI_BYTES + 1), { status: 200 }),
    );
    const e = await rejectionOf(loadOpenApiDocument("https://x.test/a", depsFor({}, f)));
    expect(e).toBeInstanceOf(OpenApiLoadError);
    expect(e.message).toContain("10485760");
  });

  test("a file past the cap is refused", async () => {
    const e = await rejectionOf(
      loadOpenApiDocument("big", depsFor({ big: new Uint8Array(MAX_OPENAPI_BYTES + 1) })),
    );
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("a YAML alias bomb is refused", async () => {
    let yaml = "openapi: 3.0.0\na0: &a0 [x, x]\n";
    for (let i = 1; i <= 150; i++) yaml += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    const e = await rejectionOf(loadOpenApiDocument("b.yaml", depsFor({ "b.yaml": yaml })));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });

  test("an unreadable file becomes an OpenApiLoadError", async () => {
    const e = await rejectionOf(loadOpenApiDocument("nope.json", depsFor({})));
    expect(e).toBeInstanceOf(OpenApiLoadError);
  });
});
