/**
 * The generated `src/request.ts`, imported from a real temp dir beside the `operations.json` the
 * generator wrote for the Petstore fixture, and driven with an injected fetch and env.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildOpenApiScaffoldFiles } from "./generate.ts";
import { buildOperationModel, type OperationDef } from "./model.ts";

type Args = Record<string, unknown>;
type Env = Record<string, string | undefined>;
interface RequestModule {
  buildRequest(op: OperationDef, args: Args, env: Env): { url: string; init: RequestInit };
  callOperation(
    op: OperationDef,
    args: Args,
    deps: { fetch: typeof fetch; env: Env },
  ): Promise<string>;
  RequestError: new (message: string) => Error;
  MAX_RESPONSE_CHARS: number;
  MAX_BODY_BYTES: number;
  TRUNCATED_MARKER: string;
  TIMEOUT_MS: number;
}

const doc = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "petstore.json"), "utf8"),
) as Record<string, unknown>;
const model = buildOperationModel(doc, { serviceId: "ext_petstore", maxOperations: 200 });
const dir = mkdtempSync(join(tmpdir(), "nimbus-openapi-request-"));
for (const f of buildOpenApiScaffoldFiles("petstore", undefined, process.platform, dir, model)) {
  const target = join(dir, ...f.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, f.content, "utf8");
}
const req = (await import(pathToFileURL(join(dir, "src", "request.ts")).href)) as RequestModule;

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold handles
  }
});

function op(tool: string): OperationDef {
  const found = model.operations.find((o) => o.tool === tool);
  if (found === undefined) throw new Error(`no ${tool}`);
  return found;
}

const ENV: Env = {
  API_KEY: "k-123",
  BEARER_AUTH: "t-456",
  BASIC_USER: "üser",
  BASIC_PASSWORD: "p:w",
};

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

/** A fetch that records each call and answers with `res`. */
function recordingFetch(res: () => Response): {
  fetch: typeof fetch;
  calls: [string, RequestInit][];
} {
  const calls: [string, RequestInit][] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    return res();
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("generated request.ts — URL and parameters", () => {
  test("path parameters are encoded, the server base path kept, query placed", () => {
    const { url } = req.buildRequest(
      op("showpetbyid"),
      { path_petId: "a/b c?", query_petId: "q&1" },
      ENV,
    );
    expect(url).toBe("https://eu.petstore.example.com/v1/pets/a%2Fb%20c%3F?petId=q%261");
  });

  test("query and header parameters land where the table says", () => {
    const { url, init } = req.buildRequest(
      op("listpets"),
      { limit: 5, "X-Request-Id": "r-1" },
      ENV,
    );
    expect(url).toBe("https://eu.petstore.example.com/v1/pets?limit=5");
    expect(headersOf(init).get("x-request-id")).toBe("r-1");
    expect(init.method).toBe("GET");
  });

  test("an array query value is repeated; an absent optional one is left out", () => {
    const { url } = req.buildRequest(op("listpets"), { limit: [1, 2] }, ENV);
    expect(url).toBe("https://eu.petstore.example.com/v1/pets?limit=1&limit=2");
    expect(req.buildRequest(op("listpets"), {}, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/pets",
    );
  });

  test("a non-default port host is kept and checked", () => {
    const { url } = req.buildRequest(op("delete_pets_petid"), { petId: "7" }, {});
    expect(url).toBe("https://admin.petstore.example.com:8443/pets/7");
  });

  test("a JSON body is serialised with its content type", () => {
    const { init } = req.buildRequest(op("createpet"), { body: { name: "rex" } }, ENV);
    expect(init.body).toBe('{"name":"rex"}');
    expect(headersOf(init).get("content-type")).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  test("redirect is manual and the call carries a timeout signal", () => {
    const { init } = req.buildRequest(op("listpets"), {}, ENV);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(req.TIMEOUT_MS).toBe(30_000);
  });
});

describe("generated request.ts — credentials", () => {
  test("an apiKey header comes from the env", () => {
    const { init } = req.buildRequest(op("listpets"), {}, ENV);
    expect(headersOf(init).get("x-api-key")).toBe("k-123");
  });

  test("bearer goes in Authorization", () => {
    const { init } = req.buildRequest(op("createpet"), { body: {} }, ENV);
    expect(headersOf(init).get("authorization")).toBe("Bearer t-456");
  });

  test("basic is base64 of user:password, UTF-8", () => {
    const { init } = req.buildRequest(op("showpetbyid"), { path_petId: "1" }, ENV);
    const expected = Buffer.from("üser:p:w", "utf8").toString("base64");
    expect(headersOf(init).get("authorization")).toBe(`Basic ${expected}`);
  });

  test("an apiKey in the query is set on the URL", () => {
    const queryOp: OperationDef = {
      ...op("listpets"),
      credential: { kind: "query", name: "api_key", env: "API_KEY" },
    };
    expect(req.buildRequest(queryOp, { limit: 1 }, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/pets?limit=1&api_key=k-123",
    );
  });

  test("the credential is applied last, so a same-named parameter cannot replace it", () => {
    const clash: OperationDef = {
      ...op("listpets"),
      params: [{ name: "X-Api-Key", in: "header", arg: "key", required: false }],
    };
    const { init } = req.buildRequest(clash, { key: "attacker" }, ENV);
    expect(headersOf(init).get("x-api-key")).toBe("k-123");
  });

  test("an unset, empty or inherited credential is refused before fetch", async () => {
    const inherited = Object.create({ API_KEY: "inherited" }) as Env;
    for (const env of [{}, { API_KEY: "" }, inherited]) {
      const rec = recordingFetch(() => new Response("x"));
      await expect(
        req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env }),
      ).rejects.toThrow(/API_KEY is not set; set it with nimbus extension credential set/);
      expect(rec.calls).toEqual([]);
    }
    expect(() =>
      req.buildRequest(op("showpetbyid"), { path_petId: "1" }, { BASIC_USER: "u" }),
    ).toThrow(/BASIC_PASSWORD is not set/);
  });
});

describe("generated request.ts — refusals", () => {
  test("a missing required parameter is refused before fetch", async () => {
    const rec = recordingFetch(() => new Response("x"));
    const err = await req
      .callOperation(op("showpetbyid"), { query_petId: "1" }, { fetch: rec.fetch, env: ENV })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(req.RequestError);
    expect((err as Error).message).toBe("missing required parameter path_petId");
    expect(rec.calls).toEqual([]);
  });

  test("names are read as own properties only", () => {
    const odd: OperationDef = {
      ...op("delete_pets_petid"),
      params: [
        { name: "petId", in: "path", arg: "petId", required: true },
        { name: "__proto__", in: "query", arg: "__proto__", required: false },
        { name: "toString", in: "query", arg: "toString", required: false },
      ],
    };
    // `{}` inherits `__proto__` and `toString`; neither may be sent.
    expect(req.buildRequest(odd, { petId: "1" }, {}).url).toBe(
      "https://admin.petstore.example.com:8443/pets/1",
    );
    const own = JSON.parse('{"petId":"1","__proto__":"p"}') as Args;
    expect(req.buildRequest(odd, own, {}).url).toBe(
      "https://admin.petstore.example.com:8443/pets/1?__proto__=p",
    );
    const required: OperationDef = {
      ...odd,
      params: [{ name: "toString", in: "query", arg: "toString", required: true }],
      path: "/pets",
    };
    expect(() => req.buildRequest(required, {}, {})).toThrow("missing required parameter toString");
  });

  test("a URL to a host the table does not declare is refused", () => {
    for (const server of ["https://evil.example.com", "http://eu.petstore.example.com/v1"]) {
      const bad: OperationDef = { ...op("listpets"), server };
      expect(() => req.buildRequest(bad, {}, ENV)).toThrow(/is not a host this extension declares/);
    }
  });

  test("a path that starts with // cannot change the host", () => {
    const sneaky: OperationDef = { ...op("delete_pets_petid"), path: "//evil.example.com/x" };
    expect(req.buildRequest(sneaky, { petId: "1" }, {}).url).toBe(
      "https://admin.petstore.example.com:8443/evil.example.com/x",
    );
  });

  test("a required non-JSON body refuses before fetch; an optional one is sent without it", async () => {
    const required: OperationDef = { ...op("createpet"), body: "unsupported", bodyRequired: true };
    const rec = recordingFetch(() => new Response("ok"));
    await expect(
      req.callOperation(required, { body: "x" }, { fetch: rec.fetch, env: ENV }),
    ).rejects.toThrow(
      "createpet requires a request body that is not JSON; edit src/request.ts to send it",
    );
    expect(rec.calls).toEqual([]);
    const optional: OperationDef = { ...required, bodyRequired: false };
    expect(await req.callOperation(optional, { body: "x" }, { fetch: rec.fetch, env: ENV })).toBe(
      "HTTP 200\nok",
    );
    expect(rec.calls).toHaveLength(1);
    const init = rec.calls[0]?.[1] ?? {};
    expect(init.body).toBeUndefined();
    expect(headersOf(init).has("content-type")).toBe(false);
  });

  test('a path value of "." or ".." is refused before fetch', async () => {
    // At the root of the path, ".." would climb past the server's /v1 base path.
    const rootParam: OperationDef = { ...op("showpetbyid"), path: "/{petId}" };
    for (const o of [op("showpetbyid"), rootParam]) {
      for (const value of [".", ".."]) {
        const rec = recordingFetch(() => new Response("x"));
        await expect(
          req.callOperation(o, { path_petId: value }, { fetch: rec.fetch, env: ENV }),
        ).rejects.toThrow(`path parameter path_petId may not be "." or ".."`);
        expect(rec.calls).toEqual([]);
      }
    }
    // Dots inside a longer value are only text: encoded, never a segment of their own.
    expect(req.buildRequest(rootParam, { path_petId: "../x" }, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/..%2Fx",
    );
    expect(req.buildRequest(rootParam, { path_petId: "..." }, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/...",
    );
  });

  test("a JSON body over 10 MiB of UTF-8 is refused before fetch", async () => {
    expect(req.MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
    const rec = recordingFetch(() => new Response("x"));
    // Under the cap in UTF-16 code units, over it in UTF-8 bytes (é is two bytes).
    const big = "é".repeat(req.MAX_BODY_BYTES / 2);
    await expect(
      req.callOperation(op("createpet"), { body: big }, { fetch: rec.fetch, env: ENV }),
    ).rejects.toThrow(`the request body is larger than ${req.MAX_BODY_BYTES} bytes`);
    expect(rec.calls).toEqual([]);
    const fits = "a".repeat(req.MAX_BODY_BYTES - 2);
    expect(req.buildRequest(op("createpet"), { body: fits }, ENV).init.body).toBe(
      JSON.stringify(fits),
    );
  });
});

describe("generated request.ts — responses", () => {
  test("a 2xx returns the status and the body", async () => {
    const rec = recordingFetch(() => new Response("[]", { status: 200 }));
    const out = await req.callOperation(
      op("listpets"),
      { limit: 1 },
      { fetch: rec.fetch, env: ENV },
    );
    expect(out).toBe("HTTP 200\n[]");
    expect(rec.calls[0]?.[0]).toBe("https://eu.petstore.example.com/v1/pets?limit=1");
    expect(rec.calls[0]?.[1].redirect).toBe("manual");
  });

  test("a 3xx returns the status and Location, never following it", async () => {
    const rec = recordingFetch(
      () =>
        new Response("moved", {
          status: 302,
          headers: { location: "https://other.example.com/x" },
        }),
    );
    const out = await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV });
    expect(out).toBe("HTTP 302; redirect to https://other.example.com/x not followed");
    expect(rec.calls).toHaveLength(1);
    const bare = recordingFetch(() => new Response(null, { status: 301 }));
    expect(await req.callOperation(op("listpets"), {}, { fetch: bare.fetch, env: ENV })).toBe(
      "HTTP 301; redirect to (no Location header) not followed",
    );
  });

  test("a non-2xx body is returned with its status", async () => {
    const rec = recordingFetch(() => new Response("nope", { status: 404 }));
    expect(await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV })).toBe(
      "HTTP 404\nnope",
    );
  });

  test("a 70,000-character body is cut at 65,536 with the marker", async () => {
    const rec = recordingFetch(() => new Response("x".repeat(70_000)));
    const out = await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV });
    expect(req.MAX_RESPONSE_CHARS).toBe(65_536);
    expect(req.TRUNCATED_MARKER).toBe("\n[truncated]");
    expect(out).toBe(`HTTP 200\n${"x".repeat(65_536)}\n[truncated]`);
  });

  test("the cut never splits a surrogate pair", async () => {
    const text = `${"a".repeat(65_535)}\u{1F600}tail`;
    const rec = recordingFetch(() => new Response(text));
    const out = await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV });
    expect(out).toBe(`HTTP 200\n${"a".repeat(65_535)}\n[truncated]`);
  });

  test("a 304 is reported as not modified", async () => {
    const rec = recordingFetch(() => new Response(null, { status: 304 }));
    expect(await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV })).toBe(
      "HTTP 304 not modified",
    );
  });
});
