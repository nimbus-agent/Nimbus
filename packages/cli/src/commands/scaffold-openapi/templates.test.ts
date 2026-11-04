/**
 * The generated `src/request.ts`, imported from a real temp dir beside the `operations.json` the
 * generator wrote for the Petstore fixture, and driven with an injected fetch and env.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  MAX_READ_BYTES: number;
  assertWithinBase(op: OperationDef, url: URL): void;
  checkedUrl(op: OperationDef, href: string): URL;
  TRUNCATED_MARKER: string;
  REQUEST_TIMEOUT_MS: number;
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

interface ToolsModule {
  createServer(deps: { fetch?: typeof fetch; env?: Env }): {
    connect(t: unknown): Promise<void>;
  };
  errorText(e: unknown): string;
}

/** The nearest `node_modules/<pkg>` at or above `from` (the linker decides where). */
function installedPackageDir(pkg: string, from: string): string {
  let at = from;
  for (;;) {
    const candidate = join(at, "node_modules", ...pkg.split("/"));
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) throw new Error(`${pkg} is not installed at or above ${from}`);
    at = parent;
  }
}

mkdirSync(join(dir, "node_modules", "@modelcontextprotocol"), { recursive: true });
symlinkSync(
  realpathSync(
    installedPackageDir("@modelcontextprotocol/sdk", resolve(import.meta.dir, "..", "..", "..")),
  ),
  join(dir, "node_modules", "@modelcontextprotocol", "sdk"),
  "junction",
);
// After the junction: an import before it would cache the missing node_modules.
const req = (await import(pathToFileURL(join(dir, "src", "request.ts")).href)) as RequestModule;
const tools = (await import(pathToFileURL(join(dir, "src", "tools.ts")).href)) as ToolsModule;

/** The generated server for the Petstore table, driven in memory. */
async function toolClient(fetchImpl: typeof fetch, env: Env): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await tools.createServer({ fetch: fetchImpl, env }).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

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
  BASIC_USER: "user",
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
    expect(req.REQUEST_TIMEOUT_MS).toBe(30_000);
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

  test("basic is base64 of user:password", () => {
    const { init } = req.buildRequest(op("showpetbyid"), { path_petId: "1" }, ENV);
    const expected = Buffer.from("user:p:w", "utf8").toString("base64");
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

describe("generated tools.ts — errors never carry a credential", () => {
  test("a bearer secret a header cannot carry is refused without quoting it", async () => {
    for (const secretValue of ["SECRET\nX-Evil: 1", "SECRÉT-123", "SEC\u0000RET"]) {
      const rec = recordingFetch(() => new Response("ok"));
      const client = await toolClient(rec.fetch, { ...ENV, BEARER_AUTH: secretValue });
      const out = await client.callTool({ name: "createpet", arguments: { body: {} } });
      expect(out.isError).toBe(true);
      const text = JSON.stringify(out.content);
      expect(text).toContain(
        "credential BEARER_AUTH contains characters an HTTP header cannot carry",
      );
      expect(text).not.toContain("SEC");
      expect(rec.calls).toEqual([]);
    }
  });

  test("any other error becomes fixed text, whatever its message says", async () => {
    const throwing = (async () => {
      throw new TypeError("Header 'authorization' has invalid value: 'Bearer t-456'");
    }) as unknown as typeof fetch;
    const client = await toolClient(throwing, ENV);
    const out = await client.callTool({ name: "createpet", arguments: { body: {} } });
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([
      { type: "text", text: "the request could not be sent (TypeError)" },
    ]);
    expect(tools.errorText("plain")).toBe("the request could not be sent (string)");
    expect(tools.errorText(new req.RequestError("why"))).toBe("why");
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
        ).rejects.toThrow(`showpetbyid: the filled path would have a "." or ".." segment`);
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

  test("a path template with a space, backslash or control character is refused before fetch", async () => {
    // WHATWG reads "\" as "/" for https and drops tab/LF before resolving dot-segments:
    // unchecked, "/x\..\..\y" became https://host/y, above the /v1 base path.
    for (const path of [
      "/a/..\\b",
      "/a/.\t./b",
      "/x\\..\\..\\y",
      "/a\r\n/b",
      "/a\u0000b",
      "/a\u007fb",
      // A trailing space is trimmed by the parser, which then resolves "..".
      "/.. ",
      "/x/.. ",
      "/a b",
    ]) {
      const edited: OperationDef = { ...op("listpets"), path };
      const rec = recordingFetch(() => new Response("x"));
      await expect(req.callOperation(edited, {}, { fetch: rec.fetch, env: ENV })).rejects.toThrow(
        "listpets: the path has a character the URL parser would rewrite",
      );
      expect(rec.calls).toEqual([]);
    }
    // A normal templated path still works, and a filled value cannot add a backslash.
    expect(req.buildRequest(op("showpetbyid"), { path_petId: "a\\..\\b" }, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/pets/a%5C..%5Cb",
    );
  });

  test("checkedUrl, the one door every request URL takes, refuses a URL above the base path", () => {
    // Pins the base-path guard's CALL: no template reaches it past the character and dot checks.
    const listpets = op("listpets");
    expect(() => req.checkedUrl(listpets, "https://eu.petstore.example.com/y")).toThrow(
      "listpets: the URL would leave the server's base path",
    );
    expect(() => req.checkedUrl(listpets, "https://evil.example.com/v1/pets")).toThrow(
      "evil.example.com is not a host this extension declares",
    );
    expect(req.checkedUrl(listpets, "https://eu.petstore.example.com/v1/pets").href).toBe(
      "https://eu.petstore.example.com/v1/pets",
    );
  });

  test("the URL must stay under the server's own base path, whatever the parser did", () => {
    const listpets = op("listpets");
    const check = (href: string): void => req.assertWithinBase(listpets, new URL(href));
    check("https://eu.petstore.example.com/v1");
    check("https://eu.petstore.example.com/v1/");
    check("https://eu.petstore.example.com/v1/pets/1");
    for (const href of [
      "https://eu.petstore.example.com/y",
      "https://eu.petstore.example.com/v10/pets",
      "https://eu.petstore.example.com/",
    ]) {
      expect(() => check(href)).toThrow("listpets: the URL would leave the server's base path");
    }
    // A server with no base path accepts any path on its host.
    const root: OperationDef = { ...listpets, server: "https://eu.petstore.example.com/" };
    req.assertWithinBase(root, new URL("https://eu.petstore.example.com/anything"));
    // A trailing-slash base is normalised.
    const slash: OperationDef = { ...listpets, server: "https://eu.petstore.example.com/v1//" };
    req.assertWithinBase(slash, new URL("https://eu.petstore.example.com/v1/pets"));
  });

  test("a dot-segment composed from several values, or spelled %2e, is refused", () => {
    const composed: OperationDef = {
      ...op("showpetbyid"),
      path: "/x/{a}..{b}",
      params: [
        { name: "a", in: "path", arg: "a", required: true },
        { name: "b", in: "path", arg: "b", required: true },
      ],
    };
    const refused = /showpetbyid: the filled path would have a "\." or "\.\." segment/;
    expect(() => req.buildRequest(composed, { a: "", b: "" }, ENV)).toThrow(refused);
    const adjacent: OperationDef = { ...composed, path: "/x/{a}{b}" };
    expect(() => req.buildRequest(adjacent, { a: ".", b: "." }, ENV)).toThrow(refused);
    expect(() => req.buildRequest(adjacent, { a: "", b: "." }, ENV)).toThrow(refused);
    expect(req.buildRequest(composed, { a: "1", b: "2" }, ENV).url).toBe(
      "https://eu.petstore.example.com/v1/x/1..2",
    );
    // A hand-edited table: the URL parser reads %2e%2E as "..".
    for (const path of ["/x/%2e%2E", "/x/.%2E/y", "/%2e"]) {
      const edited: OperationDef = { ...op("listpets"), path };
      expect(() => req.buildRequest(edited, {}, ENV)).toThrow(
        /would have a "\." or "\.\." segment/,
      );
    }
  });

  test("a header parameter naming Host or another forbidden header is refused at runtime", () => {
    for (const name of [
      "Host",
      "cookie",
      "Proxy-Authorization",
      "Content-Length",
      "Authorization",
      "bad name",
      "x\r\ny",
    ]) {
      const edited: OperationDef = {
        ...op("listpets"),
        params: [{ name, in: "header", arg: "h", required: false }],
      };
      expect(() => req.buildRequest(edited, { h: "evil.example.com" }, ENV)).toThrow(
        "the header parameter h names a header this extension may not set",
      );
    }
    const credential: OperationDef = {
      ...op("listpets"),
      credential: { kind: "header", name: "Host", env: "API_KEY" },
    };
    expect(() => req.buildRequest(credential, {}, ENV)).toThrow(
      "the credential names a header this extension may not set",
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

  test("a redirect's Location is reported without its query or fragment", async () => {
    const located = (location: string) =>
      recordingFetch(() => new Response(null, { status: 307, headers: { location } }));
    const secretOne = located("https://other.example.com/next?api_key=SECRET#token=SECRET");
    expect(await req.callOperation(op("listpets"), {}, { fetch: secretOne.fetch, env: ENV })).toBe(
      "HTTP 307; redirect to https://other.example.com/next not followed",
    );
    const relative = located("/elsewhere?x=SECRET");
    expect(await req.callOperation(op("listpets"), {}, { fetch: relative.fetch, env: ENV })).toBe(
      "HTTP 307; redirect to https://eu.petstore.example.com/elsewhere not followed",
    );
    const broken = located("https://[bad");
    expect(await req.callOperation(op("listpets"), {}, { fetch: broken.fetch, env: ENV })).toBe(
      "HTTP 307; redirect to (an unusable Location header) not followed",
    );
  });

  test("the body is read only up to MAX_READ_BYTES, then cut with the marker", async () => {
    expect(req.MAX_READ_BYTES).toBe(4 * 65_536);
    const chunk = new Uint8Array(65_536).fill(0x61);
    let pulled = 0;
    // 2 MiB in all: a reader that ignored the cap would pull every chunk.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 32 * chunk.byteLength) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const rec = recordingFetch(() => new Response(endless));
    const out = await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV });
    expect(out).toBe(`HTTP 200\n${"a".repeat(65_536)}\n[truncated]`);
    expect(pulled).toBeLessThanOrEqual(req.MAX_READ_BYTES + 2 * chunk.byteLength);
  });

  test("a body cut at the byte cap of 3-byte characters still exceeds the char cap", async () => {
    // UTF-8 spends at most 3 bytes per UTF-16 unit, the worst case for the byte cap.
    const body = "€".repeat(req.MAX_READ_BYTES);
    const rec = recordingFetch(() => new Response(body));
    const out = await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV });
    expect(out).toBe(`HTTP 200
${"€".repeat(65_536)}
[truncated]`);
  });

  test("a 304 is reported as not modified", async () => {
    const rec = recordingFetch(() => new Response(null, { status: 304 }));
    expect(await req.callOperation(op("listpets"), {}, { fetch: rec.fetch, env: ENV })).toBe(
      "HTTP 304 not modified",
    );
  });
});
