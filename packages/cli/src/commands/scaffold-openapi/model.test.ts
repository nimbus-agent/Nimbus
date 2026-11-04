import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseExtensionManifestForRegistry } from "@nimbus-dev/registry-format";
import {
  buildOperationModel,
  MAX_DESCRIPTION_CHARS,
  NO_SERVER_MESSAGE,
  OpenApiModelError,
  type OperationModel,
} from "./model.ts";

const SERVICE_ID = "ext_petstore";
const OPTS = { serviceId: SERVICE_ID, maxOperations: 200 } as const;

function loadFixture(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dir, "__fixtures__", "petstore.json"), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

type Doc = Record<string, unknown>;

/** A one-operation document; `op` and `extra` are merged in. */
function doc(op: Doc = {}, extra: Doc = {}): Doc {
  return {
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.com" }],
    paths: { "/things": { get: { operationId: "listThings", ...op } } },
    ...extra,
  };
}

function build(d: Doc, opts: { serviceId: string; maxOperations: number } = OPTS): OperationModel {
  return buildOperationModel(d, opts);
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

/** The manifest Task 3 will write, parsed with the registry's own parser. */
function manifestParses(model: OperationModel): void {
  const manifest = {
    id: "petstore",
    version: "0.1.0",
    permissions: { network: model.hosts },
    ...(Object.keys(model.credentials).length > 0 ? { credentials: model.credentials } : {}),
  };
  const parsed = parseExtensionManifestForRegistry(JSON.stringify(manifest)).manifest;
  expect(parsed.permissions.network).toEqual([...model.hosts]);
  expect(parsed.credentials ?? {}).toEqual({ ...model.credentials });
}

/** Pet, nested `levels` times through `parent` before the cycle is cut to {}. */
function petAt(levels: number): unknown {
  let node: unknown = {};
  for (let i = 0; i < levels; i++) {
    node = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, parent: node },
    };
  }
  return node;
}

describe("buildOperationModel — the Petstore fixture", () => {
  test("gives the exact model", () => {
    const model = build(loadFixture());
    expect(model).toEqual({
      hosts: ["admin.petstore.example.com:8443", "eu.petstore.example.com"],
      operations: [
        {
          tool: "listpets",
          method: "GET",
          path: "/pets",
          server: "https://eu.petstore.example.com/v1",
          params: [
            { name: "limit", in: "query", arg: "limit", required: false },
            { name: "X-Request-Id", in: "header", arg: "X-Request-Id", required: false },
          ],
          body: null,
          bodyRequired: false,
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "integer", maximum: 100 },
              "X-Request-Id": { type: "string" },
            },
          },
          description: "List all pets",
          credential: { kind: "header", name: "X-Api-Key", env: "API_KEY" },
        },
        {
          tool: "createpet",
          method: "POST",
          path: "/pets",
          server: "https://eu.petstore.example.com/v1",
          params: [],
          body: "json",
          bodyRequired: true,
          inputSchema: {
            type: "object",
            properties: { body: petAt(8) },
            required: ["body"],
          },
          description: "Create a pet in the store",
          credential: { kind: "bearer", env: "BEARER_AUTH" },
        },
        {
          tool: "showpetbyid",
          method: "GET",
          path: "/pets/{petId}",
          server: "https://eu.petstore.example.com/v1",
          params: [
            { name: "petId", in: "path", arg: "path_petId", required: true },
            { name: "petId", in: "query", arg: "query_petId", required: false },
          ],
          body: null,
          bodyRequired: false,
          inputSchema: {
            type: "object",
            properties: {
              path_petId: { type: "string", description: "The pet id" },
              query_petId: { type: "string" },
            },
            required: ["path_petId"],
          },
          description: "Info for a specific pet",
          credential: { kind: "basic", env: "BASIC_USER", passwordEnv: "BASIC_PASSWORD" },
        },
        {
          tool: "delete_pets_petid",
          method: "DELETE",
          path: "/pets/{petId}",
          server: "https://admin.petstore.example.com:8443",
          params: [{ name: "petId", in: "path", arg: "petId", required: true }],
          body: null,
          bodyRequired: false,
          inputSchema: {
            type: "object",
            properties: { petId: { type: "string", description: "The pet id" } },
            required: ["petId"],
          },
          description: "Delete a pet",
          credential: null,
        },
      ],
      credentials: {
        api_key: { env: "API_KEY" },
        bearer_auth: { env: "BEARER_AUTH" },
        basic_user: { env: "BASIC_USER" },
        basic_password: { env: "BASIC_PASSWORD" },
      },
      skipped: [],
      unsupportedSchemes: ["oauth (oauth2)"],
      warnings: [
        "POST /pets: $ref #/components/schemas/Pet nests more than 8 deep (a cycle?); cut to {}",
      ],
      cutNames: [],
    });
  });

  test("its manifest parses with the registry parser", () => {
    manifestParses(build(loadFixture()));
  });

  test("maps built from document keys have no prototype", () => {
    const model = build(loadFixture());
    expect(Object.getPrototypeOf(model.credentials)).toBeNull();
    expect(Object.getPrototypeOf(model.operations[0]?.inputSchema)).toBeNull();
  });
});

describe("hosts", () => {
  const serverWarnings = (servers: unknown[]): readonly string[] =>
    build(doc({ servers: [...servers, { url: "https://ok.example.com" }] })).warnings;

  test("server-variable defaults are substituted", () => {
    const m = build(
      doc(
        {},
        {
          servers: [{ url: "https://{env}.example.com", variables: { env: { default: "prod" } } }],
        },
      ),
    );
    expect(m.hosts).toEqual(["prod.example.com"]);
    expect(m.operations[0]?.server).toBe("https://prod.example.com");
  });

  test("a server with a variable that has no default is skipped with a warning", () => {
    expect(
      serverWarnings([{ url: "https://{tenant}.example.com", variables: { tenant: {} } }]),
    ).toEqual(["server https://{tenant}.example.com: variable {tenant} has no default; skipped"]);
    expect(serverWarnings([{ url: "https://{undeclared}.example.com" }])).toEqual([
      "server https://{undeclared}.example.com: variable {undeclared} has no default; skipped",
    ]);
  });

  test("an http: server is skipped with a warning", () => {
    expect(serverWarnings([{ url: "http://api.example.com" }])).toEqual([
      "server http://api.example.com: not https; skipped",
    ]);
  });

  test("IPv4 and IPv6 literals are skipped with a warning", () => {
    expect(
      serverWarnings([{ url: "https://10.0.0.1/api" }, { url: "https://[::1]:8443" }]),
    ).toEqual([
      "server https://10.0.0.1/api: is an IP literal; skipped",
      "server https://[::1]:8443: is an IP literal; skipped",
    ]);
  });

  test("localhost and *.local are skipped with a warning", () => {
    expect(
      serverWarnings([{ url: "https://localhost:3000" }, { url: "https://printer.local" }]),
    ).toEqual([
      "server https://localhost:3000: is a local host name; skipped",
      "server https://printer.local: is a local host name; skipped",
    ]);
  });

  test("a relative server, credentials, a query and a bad hostname are skipped with a warning", () => {
    expect(
      serverWarnings([
        { url: "/v1" },
        { url: "https://u:p@api.example.com" },
        { url: "https://api.example.com/?k=1" },
        { url: "https://bad_host.example.com" },
        { nourl: true },
      ]),
    ).toEqual([
      "server /v1: not an absolute URL; skipped",
      "server https://u:p@api.example.com: carries credentials; skipped",
      "server https://api.example.com/?k=1: has a query or fragment; skipped",
      "server https://bad_host.example.com: host bad_host.example.com is not a valid hostname; skipped",
      "a server has no url; skipped",
    ]);
  });

  test("port 443 or none gives the bare host, any other port host:port", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://a.example.com:443/base" }],
      paths: {
        "/x": { get: { operationId: "x" } },
        "/y": { get: { operationId: "y", servers: [{ url: "https://b.example.com:9443" }] } },
      },
    });
    expect(m.hosts).toEqual(["a.example.com", "b.example.com:9443"]);
    expect(m.operations.map((o) => o.server)).toEqual([
      "https://a.example.com/base",
      "https://b.example.com:9443",
    ]);
  });

  test("hosts are deduplicated and sorted", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://z.example.com" }],
      paths: {
        "/a": { get: { operationId: "a" } },
        "/b": { get: { operationId: "b", servers: [{ url: "https://a.example.com" }] } },
        "/c": { get: { operationId: "c" } },
      },
    });
    expect(m.hosts).toEqual(["a.example.com", "z.example.com"]);
  });

  test("a path item's servers are used before the document's", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://doc.example.com" }],
      paths: {
        "/a": { servers: [{ url: "https://path.example.com" }], get: { operationId: "a" } },
      },
    });
    expect(m.hosts).toEqual(["path.example.com"]);
  });

  test("no usable server refuses the document", () => {
    const e = errorOf(() => build(doc({}, { servers: [{ url: "http://api.example.com" }] })));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe(NO_SERVER_MESSAGE);
    expect(NO_SERVER_MESSAGE).toBe("the document names no https server the extension could call");
    expect(errorOf(() => build(doc({}, { servers: undefined }))).message).toBe(NO_SERVER_MESSAGE);
  });

  test("an operation whose own servers all fail is skipped with a reason", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/a": { get: { operationId: "a" } },
        "/b": { get: { operationId: "b", servers: [{ url: "http://b.example.com" }] } },
        "/c": { servers: [{ url: "https://127.0.0.1" }], get: { operationId: "c" } },
      },
    });
    expect(m.operations.map((o) => o.tool)).toEqual(["a"]);
    expect(m.skipped).toEqual([
      { operation: "GET /b", reason: "none of its servers is a usable https server" },
      { operation: "GET /c", reason: "none of its path's servers is a usable https server" },
    ]);
  });

  test("an operation with no server at all is skipped when others have their own", () => {
    const m = build({
      openapi: "3.0.0",
      paths: {
        "/a": { get: { operationId: "a" } },
        "/b": { get: { operationId: "b", servers: [{ url: "https://b.example.com" }] } },
      },
    });
    expect(m.skipped).toEqual([{ operation: "GET /a", reason: "no usable https server" }]);
    expect(m.hosts).toEqual(["b.example.com"]);
  });

  test("a manifest with every kind of accepted host parses", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://xn--bcher-kva.example/" }],
      paths: {
        "/a": { get: { operationId: "a" } },
        "/b": { get: { operationId: "b", servers: [{ url: "https://B.Example.com:8080/v2" }] } },
      },
    });
    expect(m.hosts).toEqual(["b.example.com:8080", "xn--bcher-kva.example"]);
    manifestParses(m);
  });
});

describe("tool names", () => {
  test("operationId normalised to [a-z0-9_]", () => {
    expect(build(doc({ operationId: "Things.List-ALL" })).operations[0]?.tool).toBe(
      "things_list_all",
    );
  });

  test("no operationId falls back to <method>_<path segments>", () => {
    expect(build(doc({ operationId: undefined })).operations[0]?.tool).toBe("get_things");
  });

  test("two operations that normalise to the same name get _2", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/a": { get: { operationId: "listThings" } },
        "/b": { get: { operationId: "list-things" } },
        "/c": { get: { operationId: "LIST_THINGS" } },
      },
    });
    expect(m.operations.map((o) => o.tool)).toEqual(["listthings", "list_things", "list_things_2"]);
    expect(m.cutNames).toEqual([]);
  });

  test("the cap is 64 - len(serviceId) - 2; a cut name is listed and names stay distinct", () => {
    const serviceId = "ext_a_rather_long_service_name"; // 30 → cap 32
    const long = "x".repeat(40);
    const m = build(
      {
        openapi: "3.0.0",
        servers: [{ url: "https://api.example.com" }],
        paths: {
          "/a": { get: { operationId: `${long}a` } },
          "/b": { get: { operationId: `${long}b` } },
        },
      },
      { serviceId, maxOperations: 200 },
    );
    const tools = m.operations.map((o) => o.tool);
    expect(tools).toEqual(["x".repeat(32), `${"x".repeat(30)}_2`]);
    expect(new Set(tools).size).toBe(2);
    for (const t of tools) expect(t.length).toBeLessThanOrEqual(64 - serviceId.length - 2);
    expect(m.cutNames).toEqual([
      { from: `${long}a`, to: "x".repeat(32) },
      { from: `${long}b`, to: `${"x".repeat(30)}_2` },
    ]);
  });

  test("a service id that leaves too little room is refused", () => {
    const serviceId = `ext_${"s".repeat(52)}`; // 56 → cap 6
    expect(errorOf(() => build(doc(), { serviceId, maxOperations: 200 })).message).toBe(
      `the service id ${serviceId} leaves 6 characters for tool names; choose a shorter extension name`,
    );
  });
});

describe("input schema", () => {
  test("path, query and header parameters; a cross-location clash is prefixed", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/t/{id}": {
          get: {
            operationId: "t",
            parameters: [
              { name: "id", in: "path", schema: { type: "integer" } },
              { name: "id", in: "header", required: true },
              { name: "q", in: "query", required: true, schema: { type: "string" } },
            ],
          },
        },
      },
    });
    const op = m.operations[0];
    expect(op?.params).toEqual([
      { name: "id", in: "path", arg: "path_id", required: true },
      { name: "id", in: "header", arg: "header_id", required: true },
      { name: "q", in: "query", arg: "q", required: true },
    ]);
    expect(op?.inputSchema).toEqual({
      type: "object",
      properties: { path_id: { type: "integer" }, header_id: {}, q: { type: "string" } },
      required: ["path_id", "header_id", "q"],
    });
  });

  test("an operation parameter replaces the path item's of the same name and location", () => {
    const m = build({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/t": {
          parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
          get: {
            operationId: "t",
            parameters: [{ name: "q", in: "query", schema: { type: "integer" } }],
          },
        },
      },
    });
    expect(m.operations[0]?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "integer" } },
    });
  });

  test("an application/json body adds body; a +json body counts", () => {
    const json = build(
      doc({
        requestBody: {
          content: { "application/json; charset=utf-8": { schema: { type: "object" } } },
        },
      }),
    ).operations[0];
    expect(json?.body).toBe("json");
    expect(json?.inputSchema).toEqual({ type: "object", properties: { body: { type: "object" } } });
    const plus = build(doc({ requestBody: { content: { "application/merge-patch+json": {} } } }))
      .operations[0];
    expect(plus?.body).toBe("json");
    expect(plus?.inputSchema).toEqual({ type: "object", properties: { body: {} } });
  });

  test("application/json is preferred over a +json type listed first", () => {
    const op = build(
      doc({
        requestBody: {
          content: {
            "application/vnd.api+json": { schema: { type: "string" } },
            "application/json": { schema: { type: "number" } },
          },
        },
      }),
    ).operations[0];
    expect(op?.inputSchema).toEqual({ type: "object", properties: { body: { type: "number" } } });
  });

  test("bodyRequired follows requestBody.required for json and unsupported bodies", () => {
    const bodyOf = (requestBody: unknown): unknown => {
      const op = build(doc({ requestBody })).operations[0];
      return [op?.body, op?.bodyRequired];
    };
    expect(bodyOf({ required: true, content: { "multipart/form-data": {} } })).toEqual([
      "unsupported",
      true,
    ]);
    expect(bodyOf({ content: { "multipart/form-data": {} } })).toEqual(["unsupported", false]);
    expect(bodyOf({ required: true, content: { "application/json": {} } })).toEqual(["json", true]);
    expect(bodyOf({ content: { "application/json": {} } })).toEqual(["json", false]);
    expect(bodyOf(undefined)).toEqual([null, false]);
  });

  test("a form or multipart body still gives a tool, marked unsupported, with no body property", () => {
    for (const media of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
      const op = build(doc({ requestBody: { required: true, content: { [media]: {} } } }))
        .operations[0];
      expect(op?.body).toBe("unsupported");
      expect(op?.inputSchema).toEqual({ type: "object", properties: {} });
    }
  });

  test("a request body with no content is no body", () => {
    expect(build(doc({ requestBody: { content: {} } })).operations[0]?.body).toBeNull();
  });

  test("a parameter named body beside a JSON body is prefixed", () => {
    const op = build(
      doc({
        parameters: [{ name: "body", in: "query" }],
        requestBody: { content: { "application/json": {} } },
      }),
    ).operations[0];
    expect(op?.params).toEqual([{ name: "body", in: "query", arg: "query_body", required: false }]);
  });

  test("a prefixed arg that collides with another parameter skips the operation", () => {
    const m = build(
      doc(
        {},
        {
          paths: {
            "/a/{id}": {
              get: {
                operationId: "a",
                parameters: [
                  { name: "id", in: "path" },
                  { name: "id", in: "query" },
                  { name: "path_id", in: "query" },
                ],
              },
            },
            "/ok": { get: { operationId: "ok" } },
          },
        },
      ),
    );
    expect(m.skipped).toEqual([
      { operation: "GET /a/{id}", reason: "parameter names collide on path_id" },
    ]);
  });

  test("a path template naming an undeclared parameter skips the operation", () => {
    const m = build(
      doc(
        {},
        {
          paths: {
            "/a/{id}": { get: { operationId: "a" } },
            "/b": { get: { operationId: "b" } },
          },
        },
      ),
    );
    expect(m.skipped).toEqual([
      { operation: "GET /a/{id}", reason: "path parameter {id} is not declared" },
    ]);
    expect(m.operations.map((o) => o.tool)).toEqual(["b"]);
  });

  test("an optional cookie parameter is ignored with a warning; a required one skips", () => {
    const m = build(
      doc(
        {},
        {
          paths: {
            "/a": { get: { operationId: "a", parameters: [{ name: "sid", in: "cookie" }] } },
            "/b": {
              get: {
                operationId: "b",
                parameters: [{ name: "sid", in: "cookie", required: true }],
              },
            },
          },
        },
      ),
    );
    expect(m.operations.map((o) => o.tool)).toEqual(["a"]);
    expect(m.operations[0]?.params).toEqual([]);
    expect(m.warnings).toEqual(["GET /a: cookie parameter sid ignored"]);
    expect(m.skipped).toEqual([
      { operation: "GET /b", reason: "required cookie parameter sid is not supported" },
    ]);
  });

  test("a malformed parameter or location skips the operation", () => {
    const m = build(
      doc(
        {},
        {
          paths: {
            "/a": { get: { operationId: "a", parameters: [{ in: "query" }] } },
            "/b": { get: { operationId: "b", parameters: [{ name: "x", in: "body" }] } },
            "/c": { get: { operationId: "c" } },
          },
        },
      ),
    );
    expect(m.skipped).toEqual([
      { operation: "GET /a", reason: "a parameter has no valid name or location" },
      { operation: "GET /b", reason: "parameter x has the unsupported location body" },
    ]);
  });

  test("a parameter named __proto__ and __proto__ schema keys are dropped with a warning", () => {
    // A bundled build inlines operations.json as an object literal, where "__proto__" vanishes.
    const parsed = JSON.parse(
      JSON.stringify(
        doc({
          parameters: [
            { name: "__proto__", in: "query", schema: { type: "string" } },
            {
              name: "q",
              in: "query",
              schema: JSON.parse(
                '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{}}}',
              ),
            },
          ],
        }),
      ),
    ) as Doc;
    const m = build(parsed);
    const props = m.operations[0]?.inputSchema["properties"] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(["q"]);
    expect(Object.keys((props["q"] as { properties: object }).properties)).toEqual(["a"]);
    expect(m.warnings).toEqual([
      "GET /things: query parameter __proto__ dropped (a bundled build cannot carry it)",
      'GET /things: a "__proto__" property was dropped (a bundled build cannot carry it)',
    ]);
  });
});

describe("description", () => {
  test("summary, else description, else the operation label", () => {
    expect(build(doc({ summary: "S", description: "D" })).operations[0]?.description).toBe("S");
    expect(build(doc({ summary: "  ", description: "D" })).operations[0]?.description).toBe("D");
    expect(build(doc()).operations[0]?.description).toBe("GET /things");
  });

  test("cut at 512 characters", () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(512);
    const d = build(doc({ summary: "a".repeat(600) })).operations[0]?.description;
    expect(d).toBe("a".repeat(512));
  });

  test("a cut never splits a surrogate pair", () => {
    const d = build(doc({ summary: `${"a".repeat(511)}😀tail` })).operations[0]?.description;
    expect(d).toBe("a".repeat(511));
  });
});

describe("credentials", () => {
  const withSchemes = (schemes: Doc, op: Doc = {}, extra: Doc = {}): OperationModel =>
    build(doc(op, { components: { securitySchemes: schemes }, ...extra }));
  /** One operation per scheme, each using it, so every scheme is a USED one. */
  const usingAll = (schemes: Doc): OperationModel => {
    const paths: Doc = {};
    Object.keys(schemes).forEach((name, i) => {
      paths[`/s${i}`] = { get: { operationId: `s${i}`, security: [{ [name]: [] }] } };
    });
    return build(doc({}, { paths, components: { securitySchemes: schemes } }));
  };

  test("apiKey in query is one entry carrying the parameter name", () => {
    const m = withSchemes(
      { key: { type: "apiKey", in: "query", name: "api_key" } },
      { security: [{ key: [] }] },
    );
    expect(m.credentials).toEqual({ key: { env: "KEY" } });
    expect(m.operations[0]?.credential).toEqual({ kind: "query", name: "api_key", env: "KEY" });
  });

  test("a scheme name not starting with a letter is prefixed c_", () => {
    const m = usingAll({ "2fa": { type: "http", scheme: "bearer" } });
    expect(m.credentials).toEqual({ c_2fa: { env: "C_2FA" } });
  });

  test("names collide to _2 and env names collide too", () => {
    const m = usingAll({
      "Api Key": { type: "http", scheme: "bearer" },
      "api-key": { type: "http", scheme: "bearer" },
      path: { type: "http", scheme: "bearer" },
      api_path: { type: "http", scheme: "bearer" },
    });
    expect(m.credentials).toEqual({
      api_key: { env: "API_KEY" },
      api_key_2: { env: "API_KEY_2" },
      path: { env: "API_PATH" },
      api_path_2: { env: "API_PATH_2" },
    });
    manifestParses(m);
  });

  test("env is prefixed API_ when it would be reserved", () => {
    const m = usingAll({
      nimbus_token: { type: "http", scheme: "bearer" },
      home: { type: "apiKey", in: "header", name: "X" },
      ld_preload: { type: "http", scheme: "basic" },
    });
    expect(m.credentials).toEqual({
      nimbus_token: { env: "API_NIMBUS_TOKEN" },
      home: { env: "API_HOME" },
      ld_preload_user: { env: "API_LD_PRELOAD_USER" },
      ld_preload_password: { env: "API_LD_PRELOAD_PASSWORD" },
    });
    manifestParses(m);
  });

  test("a long basic scheme is cut so the final names are at most 32 characters", () => {
    const name = "an_extremely_long_basic_auth_scheme_name";
    const m = usingAll({
      [name]: { type: "http", scheme: "basic" },
      [`${name}_x`]: { type: "http", scheme: "basic" },
    });
    const keys = Object.keys(m.credentials);
    expect(keys).toEqual([
      "an_extremely_long_basic_user",
      "an_extremely_long_basic_password",
      "an_extremely_long_bas_2_user",
      "an_extremely_long_bas_2_password",
    ]);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(32);
    manifestParses(m);
  });

  test("the operation's own security wins; the first supported single-scheme alternative is used", () => {
    const schemes = {
      oauth: { type: "oauth2", flows: {} },
      a: { type: "http", scheme: "bearer" },
      b: { type: "apiKey", in: "header", name: "X-B" },
    };
    const m = withSchemes(
      schemes,
      { security: [{}, { oauth: [] }, { a: [], b: [] }, { b: [] }, { a: [] }] },
      {
        security: [{ a: [] }],
      },
    );
    expect(m.operations[0]?.credential).toEqual({ kind: "header", name: "X-B", env: "B" });
  });

  test("without its own security an operation uses the document's", () => {
    const m = withSchemes({ a: { type: "http", scheme: "bearer" } }, {}, { security: [{ a: [] }] });
    expect(m.operations[0]?.credential).toEqual({ kind: "bearer", env: "A" });
  });

  test("an empty security list, no security, or only unsupported alternatives give no credential", () => {
    const schemes = { a: { type: "http", scheme: "bearer" }, o: { type: "openIdConnect" } };
    expect(
      withSchemes(schemes, { security: [] }, { security: [{ a: [] }] }).operations[0]?.credential,
    ).toBeNull();
    expect(withSchemes(schemes).operations[0]?.credential).toBeNull();
    expect(
      withSchemes(schemes, { security: [{ o: [] }, { missing: [] }] }).operations[0]?.credential,
    ).toBeNull();
  });

  test("oauth2, openIdConnect, cookie apiKey and other http schemes are listed as unsupported", () => {
    const m = withSchemes({
      o: { type: "oauth2", flows: {} },
      oidc: { type: "openIdConnect", openIdConnectUrl: "https://x" },
      cookie: { type: "apiKey", in: "cookie", name: "sid" },
      digest: { type: "http", scheme: "digest" },
      bare: { type: "http" },
      odd: { type: "apiKey", in: 3 },
      notype: {},
      junk: "string",
    });
    expect(m.unsupportedSchemes).toEqual([
      "o (oauth2)",
      "oidc (openIdConnect)",
      "cookie (apiKey in cookie)",
      "digest (http digest)",
      "bare (http with no scheme)",
      "odd (apiKey in an unknown location)",
      "notype (no type)",
      "junk (not an object)",
    ]);
    expect(m.credentials).toEqual({});
  });

  test("a $ref'd security scheme is resolved", () => {
    const m = build(
      doc(
        { security: [{ k: [] }] },
        {
          components: {
            securitySchemes: { k: { $ref: "#/components/x" } },
            x: { type: "apiKey", in: "header", name: "X-K" },
          },
        },
      ),
    );
    expect(m.operations[0]?.credential).toEqual({ kind: "header", name: "X-K", env: "K" });
  });

  test("scheme names such as constructor and __proto__ stay own data", () => {
    const parsed = JSON.parse(
      '{"openapi":"3.0.0","servers":[{"url":"https://a.example.com"}],' +
        '"paths":{"/a":{"get":{"security":[{"constructor":[]}]}},"/b":{"get":{"security":[{"__proto__":[]}]}}},' +
        '"components":{"securitySchemes":{"constructor":{"type":"http","scheme":"bearer"},' +
        '"__proto__":{"type":"http","scheme":"bearer"}}}}',
    ) as Doc;
    const m = build(parsed);
    expect(Object.keys(m.credentials)).toEqual(["constructor", "proto"]);
    expect(Object.getPrototypeOf(m.credentials)).toBeNull();
    manifestParses(m);
  });
});

describe("the operation cap", () => {
  function many(n: number): Doc {
    const paths: Doc = {};
    for (let i = 0; i < n; i++) paths[`/p${i}`] = { get: { operationId: `op${i}` } };
    return { openapi: "3.0.0", servers: [{ url: "https://api.example.com" }], paths };
  }

  test("more than 200 operations is refused", () => {
    expect(errorOf(() => build(many(201))).message).toBe(
      "the document has 201 operations, more than the cap of 200; raise it with --max-operations <n>",
    );
    expect(build(many(200)).operations).toHaveLength(200);
  });

  test("--max-operations raises the cap", () => {
    expect(build(many(201), { serviceId: SERVICE_ID, maxOperations: 201 }).operations).toHaveLength(
      201,
    );
  });

  test("a non-positive or fractional cap is refused", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        errorOf(() => build(doc(), { serviceId: SERVICE_ID, maxOperations: bad })).message,
      ).toBe(`--max-operations must be a positive integer, got ${bad}`);
    }
  });
});

describe("refusals and skips", () => {
  test("an external $ref refuses the document naming the pointer", () => {
    const e = errorOf(() =>
      build(
        doc({
          requestBody: {
            content: { "application/json": { schema: { $ref: "https://x/s.json#/Pet" } } },
          },
        }),
      ),
    );
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe("external $ref is not supported: https://x/s.json#/Pet");
  });

  test("a $ref to a missing pointer refuses the document", () => {
    const e = errorOf(() => build(doc({ parameters: [{ $ref: "#/components/parameters/Gone" }] })));
    expect(e.message).toBe("$ref #/components/parameters/Gone points at nothing in the document");
  });

  test("a document with no operations is refused", () => {
    expect(
      errorOf(() => build({ openapi: "3.0.0", servers: [{ url: "https://a.example.com" }] }))
        .message,
    ).toBe("the document has no operations");
  });

  test("a document whose every operation is skipped is refused", () => {
    expect(errorOf(() => build(doc({}, { paths: { "/a/{x}": { get: {} } } }))).message).toBe(
      "none of the document's 1 operations could be generated",
    );
  });

  test("a path item $ref is skipped; non-object path items and operations are ignored", () => {
    const m = build(
      doc(
        {},
        {
          paths: {
            "/r": { $ref: "#/paths/~1ok" },
            "/n": "nope",
            "/ok": { get: { operationId: "ok" }, post: "nope", summary: "not an operation" },
          },
        },
      ),
    );
    expect(m.skipped).toEqual([{ operation: "/r", reason: "a path item $ref is not supported" }]);
    expect(m.operations.map((o) => o.tool)).toEqual(["ok"]);
  });

  test("every method is recognised, in a fixed order", () => {
    const ops: Doc = {};
    for (const m of ["trace", "patch", "head", "options", "delete", "post", "put", "get"])
      ops[m] = {};
    const m = build(doc({}, { paths: { "/x": ops } }));
    expect(m.operations.map((o) => o.method)).toEqual([
      "GET",
      "PUT",
      "POST",
      "DELETE",
      "OPTIONS",
      "HEAD",
      "PATCH",
      "TRACE",
    ]);
  });
});

describe("fix round 1", () => {
  test("only USED schemes get credentials; an unused one never pushes a used one to _2", () => {
    const m = build(
      doc(
        { security: [{ "api-key": [] }] },
        {
          components: {
            securitySchemes: {
              "Api Key": { type: "http", scheme: "bearer" },
              "api-key": { type: "apiKey", in: "header", name: "X-Key" },
              unused_bearer: { type: "http", scheme: "bearer" },
              o: { type: "oauth2", flows: {} },
            },
          },
        },
      ),
    );
    expect(m.credentials).toEqual({ api_key: { env: "API_KEY" } });
    expect(m.operations[0]?.credential).toEqual({ kind: "header", name: "X-Key", env: "API_KEY" });
    expect(m.unsupportedSchemes).toEqual(["o (oauth2)"]);
  });

  test("the bomb shape (60 parameters of a 10^4-leaf schema) is refused by the shared budget", () => {
    const s: Doc = {};
    for (let i = 0; i < 4; i++) {
      s[`L${i}`] = { anyOf: Array.from({ length: 10 }, () => ({ $ref: `#/s/L${i + 1}` })) };
    }
    s["L4"] = { type: "string" };
    const parameters = Array.from({ length: 60 }, (_, i) => ({
      name: `p${i}`,
      in: "query",
      schema: { $ref: "#/s/L0" },
    }));
    const e = errorOf(() => build(doc({ parameters }, { s })));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe("the document expands to more than 1,000,000 schema nodes");
  });

  test("a long string referenced many times is refused by the shared budget (strings count)", () => {
    // The reviewer's shape, scaled: 1.28 M characters (20,000 nodes) referenced 60 times.
    const s: Doc = { Big: { type: "string", description: "x".repeat(64 * 20_000) } };
    const properties = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`p${i}`, { $ref: "#/s/Big" }]),
    );
    const requestBody = { content: { "application/json": { schema: { properties } } } };
    const e = errorOf(() => build(doc({ requestBody }, { s })));
    expect(e).toBeInstanceOf(OpenApiModelError);
    expect(e.message).toBe("the document expands to more than 1,000,000 schema nodes");
  });

  test("operations each under the old per-call budget are refused once their total passes the cap", () => {
    const s: Doc = {};
    for (let i = 0; i < 3; i++) {
      s[`L${i}`] = { anyOf: Array.from({ length: 10 }, () => ({ $ref: `#/s/L${i + 1}` })) };
    }
    s["L3"] = { type: "string" };
    const paths: Doc = {};
    // One parameter of 2,334 nodes per operation (under the old 100,000 per call): × 200 ≈ 467,000, × 500 ≈ 1.17M.
    const op = (i: number): Doc => ({
      get: {
        operationId: `o${i}`,
        parameters: [{ name: "q", in: "query", schema: { $ref: "#/s/L0" } }],
      },
    });
    for (let i = 0; i < 200; i++) paths[`/o${i}`] = op(i);
    expect(build(doc({}, { s, paths })).operations).toHaveLength(200);
    for (let i = 200; i < 500; i++) paths[`/o${i}`] = op(i);
    expect(
      errorOf(() => build(doc({}, { s, paths }), { serviceId: SERVICE_ID, maxOperations: 500 }))
        .message,
    ).toBe("the document expands to more than 1,000,000 schema nodes");
  });

  test("cut warnings stop at 100, then one summary line", () => {
    const parameters = Array.from({ length: 105 }, (_, i) => ({
      name: `p${i}`,
      in: "query",
      schema: { $ref: "#/c" },
    }));
    const m = build(doc({ parameters }, { c: { $ref: "#/c" } }));
    expect(m.warnings).toHaveLength(101);
    expect(m.warnings[0]).toBe(
      "GET /things: $ref #/c nests more than 8 deep (a cycle?); cut to {}",
    );
    expect(m.warnings[100]).toBe("\u2026 and 5 more cut references");
  });

  test("Accept, Content-Type and Authorization header parameters are dropped with a warning", () => {
    const m = build(
      doc({
        parameters: [
          { name: "accept", in: "header" },
          { name: "Content-Type", in: "header" },
          { name: "AUTHORIZATION", in: "header" },
          { name: "Accept", in: "query" },
        ],
      }),
    );
    expect(m.operations[0]?.params).toEqual([
      { name: "Accept", in: "query", arg: "Accept", required: false },
    ]);
    expect(m.warnings).toEqual([
      "GET /things: header parameter accept is set by the extension; dropped",
      "GET /things: header parameter Content-Type is set by the extension; dropped",
      "GET /things: header parameter AUTHORIZATION is set by the extension; dropped",
    ]);
  });

  test('an operation whose path template has a literal "." or ".." segment is skipped', () => {
    const paths: Doc = { "/ok": { get: { operationId: "ok" } } };
    for (const path of ["/a/../b", "/a/./b", "/a/%2e%2E/b", "/%2e", "/.."]) {
      paths[path] = { get: {} };
    }
    paths["/a/.../b"] = { get: { operationId: "three" } };
    paths["/a/{x}..{y}"] = {
      get: {
        operationId: "composed",
        parameters: [
          { name: "x", in: "path", required: true },
          { name: "y", in: "path", required: true },
        ],
      },
    };
    const m = build(doc({}, { paths }));
    expect(m.operations.map((o) => o.tool)).toEqual(["ok", "three", "composed"]);
    expect(m.skipped).toEqual(
      ["/a/../b", "/a/./b", "/a/%2e%2E/b", "/%2e", "/.."].map((p) => ({
        operation: `GET ${p}`,
        reason: 'the path has a "." or ".." segment',
      })),
    );
  });

  test("an operation whose path template has a space, backslash or control character is skipped", () => {
    // A trailing space is trimmed by the URL parser, which then resolves "..".
    const shapes = [
      "/a/..\\b",
      "/a/.\t./b",
      "/x\\..\\..\\y",
      "/a\nb",
      "/a\u0000b",
      "/a\u007fb",
      "/.. ",
      "/x/.. ",
      "/a b",
    ];
    const paths: Doc = {
      "/v1/pets/{id}": {
        get: { operationId: "ok", parameters: [{ name: "id", in: "path", required: true }] },
      },
    };
    for (const p of shapes) paths[p] = { get: {} };
    const m = build(doc({}, { paths }));
    expect(m.operations.map((o) => o.tool)).toEqual(["ok"]);
    expect(m.skipped).toEqual(
      shapes.map((p) => ({
        operation: `GET ${p}`,
        reason: "the path has a space, backslash or control character the URL parser would rewrite",
      })),
    );
  });

  test("a skipped operation leaves only its skip reason, not the warnings it raised", () => {
    const paths: Doc = {
      "/kept": { get: { operationId: "kept", parameters: [{ name: "c", in: "cookie" }] } },
      "/gone/{p}": {
        get: {
          operationId: "gone",
          security: [{ o: [] }],
          parameters: [{ name: "c", in: "cookie" }],
        },
      },
      "/also-gone": {
        get: {
          operationId: "also_gone",
          servers: [{ url: "http://insecure.example.com" }],
        },
      },
    };
    const m = build(
      doc({}, { paths, components: { securitySchemes: { o: { type: "oauth2", flows: {} } } } }),
    );
    expect(m.operations.map((o) => o.tool)).toEqual(["kept"]);
    expect(m.warnings).toEqual(["GET /kept: cookie parameter c ignored"]);
    expect(m.skipped).toEqual([
      { operation: "GET /gone/{p}", reason: "path parameter {p} is not declared" },
      { operation: "GET /also-gone", reason: "none of its servers is a usable https server" },
    ]);
  });

  test("Host-class and non-token header parameters are dropped with a warning", () => {
    const names = [
      "Host",
      "cookie",
      "Connection",
      "content-length",
      "Transfer-Encoding",
      "TE",
      "upgrade",
      "Keep-Alive",
      "Expect",
      "Proxy-Authorization",
      "proxy-anything",
      "bad name",
      "x:y",
    ];
    const m = build(
      doc({
        parameters: [
          ...names.map((name) => ({ name, in: "header" })),
          { name: "X-Kept", in: "header" },
          { name: "host", in: "query" },
        ],
      }),
    );
    expect(m.operations[0]?.params.map((p) => `${p.in}:${p.name}`)).toEqual([
      "header:X-Kept",
      "query:host",
    ]);
    expect(m.warnings).toEqual(
      names.map((n) => {
        const why =
          n === "bad name" || n === "x:y"
            ? "is not a valid header name"
            : "is a header the extension may not set";
        return `GET /things: header parameter ${n} ${why}; dropped`;
      }),
    );
  });

  test("an apiKey in a Host-class or non-token header is an unsupported scheme", () => {
    for (const name of ["Host", "Proxy-Authorization", "X Key"]) {
      const m = build(
        doc(
          {},
          {
            security: [{ k: [] }],
            components: { securitySchemes: { k: { type: "apiKey", in: "header", name } } },
          },
        ),
      );
      expect(m.unsupportedSchemes).toEqual(["k (apiKey in a header the extension may not set)"]);
      expect(m.operations[0]?.credential).toBeNull();
    }
    const auth = build(
      doc(
        {},
        {
          security: [{ k: [] }],
          components: {
            securitySchemes: { k: { type: "apiKey", in: "header", name: "Authorization" } },
          },
        },
      ),
    );
    expect(auth.operations[0]?.credential).toEqual({
      kind: "header",
      name: "Authorization",
      env: "K",
    });
  });

  test("a parameter that carries the chosen credential is dropped with a warning", () => {
    const schemes = {
      h: { type: "apiKey", in: "header", name: "X-Key" },
      q: { type: "apiKey", in: "query", name: "key" },
    };
    const header = build(
      doc(
        {
          security: [{ h: [] }],
          parameters: [
            { name: "x-key", in: "header" },
            { name: "X-Key", in: "query" },
          ],
        },
        { components: { securitySchemes: schemes } },
      ),
    );
    expect(header.operations[0]?.params).toEqual([
      { name: "X-Key", in: "query", arg: "X-Key", required: false },
    ]);
    expect(header.warnings).toEqual([
      "GET /things: header parameter x-key carries the credential; dropped",
    ]);
    const query = build(
      doc(
        {
          security: [{ q: [] }],
          parameters: [
            { name: "key", in: "query" },
            { name: "Key", in: "query" },
          ],
        },
        { components: { securitySchemes: schemes } },
      ),
    );
    expect(query.operations[0]?.params).toEqual([
      { name: "Key", in: "query", arg: "Key", required: false },
    ]);
    expect(query.warnings).toEqual([
      "GET /things: query parameter key carries the credential; dropped",
    ]);
  });

  test("security with no supported alternative: no credential and a warning", () => {
    const components = {
      securitySchemes: { o: { type: "oauth2", flows: {} }, a: { type: "http", scheme: "bearer" } },
    };
    const m = build(doc({ security: [{ o: [] }, { o: [], a: [] }] }, { components }));
    expect(m.operations[0]?.credential).toBeNull();
    expect(m.warnings).toEqual([
      "GET /things: no supported security alternative; generated without a credential",
    ]);
    expect(build(doc({ security: [] }, { components })).warnings).toEqual([]);
    expect(build(doc({ security: [{}, { o: [] }] }, { components })).warnings).toEqual([]);
  });

  test("a declared path parameter absent from the template is dropped with a warning", () => {
    const m = build(doc({ parameters: [{ name: "ghost", in: "path", required: true }] }));
    expect(m.operations[0]?.params).toEqual([]);
    expect(m.operations[0]?.inputSchema).toEqual({ type: "object", properties: {} });
    expect(m.warnings).toEqual([
      "GET /things: path parameter ghost is not in the path template; dropped",
    ]);
  });

  test("a localhost subdomain is rejected like .local", () => {
    expect(
      build(doc({ servers: [{ url: "https://api.localhost" }, { url: "https://ok.example.com" }] }))
        .warnings,
    ).toEqual(["server https://api.localhost: is a local host name; skipped"]);
  });

  test("a usable but unused document server is not in hosts", () => {
    const m = build(
      doc(
        {},
        { servers: [{ url: "https://first.example.com" }, { url: "https://second.example.com" }] },
      ),
    );
    expect(m.hosts).toEqual(["first.example.com"]);
    expect(m.warnings).toEqual([]);
  });
});
