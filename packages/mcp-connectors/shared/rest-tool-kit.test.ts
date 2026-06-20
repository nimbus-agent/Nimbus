import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { HttpJsonBodyResponse, McpListResult, ZodObjectSchema } from "./mcp-tool-kit.ts";
import {
  makeRestFetcher,
  makeRestToolRegistrar,
  type RestFetcherConfig,
  type RestFetchResult,
  type RestToolRegistrar,
} from "./rest-tool-kit.ts";

// ---------------------------------------------------------------------------
// globalThis.fetch stub helpers
// ---------------------------------------------------------------------------

type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  method: string;
};

let captured: CapturedRequest = { url: "", headers: {}, method: "GET" };
let originalFetch: typeof globalThis.fetch;

function stubFetch(body: string, status: number): void {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headersObj = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    for (const [k, v] of headersObj) {
      headers[k] = v;
    }
    captured = { url, headers, method: init?.method ?? "GET" };
    return new Response(body, { status });
  };
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captured = { url: "", headers: {}, method: "GET" };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// makeRestFetcher — URL resolution
// ---------------------------------------------------------------------------

describe("makeRestFetcher — URL resolution", () => {
  it("prefixes a relative path with apiBase", async () => {
    stubFetch('{"ok":true}', 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    await fetcher("/repos/owner/repo");
    expect(captured["url"]).toBe("https://api.example.com/repos/owner/repo");
  });

  it("passes through a SAME-ORIGIN absolute URL unchanged (legit pagination link)", async () => {
    stubFetch('{"ok":true}', 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    await fetcher("https://api.example.com/v2/items?$top=10");
    expect(captured["url"]).toBe("https://api.example.com/v2/items?$top=10");
  });

  it("REFUSES a cross-origin absolute URL (bearer-token exfil / SSRF guard)", async () => {
    stubFetch('{"ok":true}', 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    await expect(fetcher("https://other.example.com/v2/items?$top=10")).rejects.toThrow(
      /cross-origin/i,
    );
    // The credential-bearing fetch must NOT have been issued.
    expect(captured["url"]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// makeRestFetcher — Bearer auth header
// ---------------------------------------------------------------------------

describe("makeRestFetcher — Bearer auth header", () => {
  it("sets Authorization: Bearer <token>", async () => {
    stubFetch("{}", 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "mytoken123",
    };
    const fetcher = makeRestFetcher(cfg);
    await fetcher("/path");
    expect(captured["headers"]["authorization"]).toBe("Bearer mytoken123");
  });

  it("merges defaultHeaders into every request", async () => {
    stubFetch("{}", 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.github.com",
      token: "ghp_tok",
      defaultHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    const fetcher = makeRestFetcher(cfg);
    await fetcher("/user/repos");
    expect(captured["headers"]["accept"]).toBe("application/vnd.github+json");
    expect(captured["headers"]["x-github-api-version"]).toBe("2022-11-28");
    expect(captured["headers"]["authorization"]).toBe("Bearer ghp_tok");
  });

  it("caller init.headers override defaultHeaders but not Bearer token", async () => {
    stubFetch("{}", 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
      defaultHeaders: { Accept: "application/json" },
    };
    const fetcher = makeRestFetcher(cfg);
    await fetcher("/path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(captured["headers"]["content-type"]).toBe("application/json");
    expect(captured["headers"]["authorization"]).toBe("Bearer tok");
  });
});

// ---------------------------------------------------------------------------
// makeRestFetcher — response parsing
// ---------------------------------------------------------------------------

describe("makeRestFetcher — response parsing", () => {
  it("returns ok=true, json, text for a 200 JSON response", async () => {
    stubFetch('{"id":42}', 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    const result: RestFetchResult = await fetcher("/item/42");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ id: 42 });
    expect(result.text).toBe('{"id":42}');
  });

  it("returns ok=false with status and text for a 404 response", async () => {
    stubFetch("not found", 404);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    const result: RestFetchResult = await fetcher("/missing");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.text).toBe("not found");
    expect(result.json).toBeNull();
  });

  it("sets json=null when the body is not valid JSON", async () => {
    stubFetch("plain text", 200);

    const cfg: RestFetcherConfig = {
      apiBase: "https://api.example.com",
      token: "tok",
    };
    const fetcher = makeRestFetcher(cfg);
    const result: RestFetchResult = await fetcher("/text");
    expect(result.json).toBeNull();
    expect(result.text).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// makeRestToolRegistrar — the standard-tool body factory
// ---------------------------------------------------------------------------

type CapturedTool = {
  name: string;
  description: string;
  handler: (args: unknown) => Promise<McpListResult>;
};

/** A registrar that records what was registered so we can drive the wrapped handler. */
function makeCapturingRegistrar(sink: CapturedTool[]): RestToolRegistrar {
  return (name, description, _schema, handler) => {
    sink.push({
      name,
      description,
      handler: handler as (args: unknown) => Promise<McpListResult>,
    });
  };
}

/** A no-validation schema — the helper only forwards it to the registrar. */
function passthroughSchema<T>(): ZodObjectSchema<T> {
  return {
    shape: {},
    safeParse: (args: unknown) => ({ success: true, data: args as T }),
  };
}

type FetchCall = { token: string; pathOrUrl: string; init: RequestInit | undefined };

describe("makeRestToolRegistrar", () => {
  const TOKEN_ENV = "TEST_REST_KIT_TOKEN";

  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  it("standard tool: reads the token env, fetches buildPath, wraps the ok json", async () => {
    process.env[TOKEN_ENV] = "secret-tok";
    const tools: CapturedTool[] = [];
    const calls: FetchCall[] = [];
    const fetch = async (
      token: string,
      pathOrUrl: string,
      init?: RequestInit,
    ): Promise<HttpJsonBodyResponse> => {
      calls.push({ token, pathOrUrl, init });
      return { ok: true, status: 200, json: { id: 7 }, text: '{"id":7}' };
    };
    const register = makeRestToolRegistrar({
      registrar: makeCapturingRegistrar(tools),
      tokenEnv: TOKEN_ENV,
      serviceLabel: "Svc",
      fetch,
    });

    register(
      "svc_get",
      "Get a thing.",
      passthroughSchema<{ id: number }>(),
      (a) => `/things/${String(a.id)}`,
    );

    const tool = tools[0];
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("svc_get");
    expect(tool?.description).toBe("Get a thing.");

    const res = await tool?.handler({ id: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe("secret-tok");
    expect(calls[0]?.pathOrUrl).toBe("/things/7");
    expect(calls[0]?.init).toBeUndefined();
    expect(res).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: 7 }, null, 2) }] });
  });

  it("passes buildInit (method/body) through to the fetcher", async () => {
    process.env[TOKEN_ENV] = "tok";
    const tools: CapturedTool[] = [];
    const calls: FetchCall[] = [];
    const fetch = async (
      token: string,
      pathOrUrl: string,
      init?: RequestInit,
    ): Promise<HttpJsonBodyResponse> => {
      calls.push({ token, pathOrUrl, init });
      return { ok: true, status: 200, json: {}, text: "{}" };
    };
    const register = makeRestToolRegistrar({
      registrar: makeCapturingRegistrar(tools),
      tokenEnv: TOKEN_ENV,
      serviceLabel: "Svc",
      fetch,
    });

    register(
      "svc_post",
      "Post a thing.",
      passthroughSchema<{ name: string }>(),
      () => "/things",
      (a) => ({ method: "POST", body: JSON.stringify({ name: a.name }) }),
    );

    await tools[0]?.handler({ name: "x" });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("applies snippetMax to the error message on a non-ok response", async () => {
    process.env[TOKEN_ENV] = "tok";
    const tools: CapturedTool[] = [];
    const fetch = async (): Promise<HttpJsonBodyResponse> => ({
      ok: false,
      status: 500,
      json: null,
      text: "ABCDEFGHIJ",
    });
    const register = makeRestToolRegistrar({
      registrar: makeCapturingRegistrar(tools),
      tokenEnv: TOKEN_ENV,
      serviceLabel: "Svc",
      fetch,
      snippetMax: 3,
    });

    register("svc_err", "Errors.", passthroughSchema<Record<string, never>>(), () => "/boom");

    const tool = tools[0];
    expect(tool).toBeDefined();
    await expect(tool?.handler({})).rejects.toThrow("Svc 500: ABC");
  });

  it("omitting snippetMax falls back to mcpJsonResultIfOk's 300-char default", async () => {
    process.env[TOKEN_ENV] = "tok";
    const tools: CapturedTool[] = [];
    const fetch = async (): Promise<HttpJsonBodyResponse> => ({
      ok: false,
      status: 502,
      json: null,
      text: "x".repeat(350),
    });
    const register = makeRestToolRegistrar({
      registrar: makeCapturingRegistrar(tools),
      tokenEnv: TOKEN_ENV,
      serviceLabel: "Svc",
      fetch,
      // snippetMax intentionally omitted → must default to 300
    });

    register("svc_long", "Long error.", passthroughSchema<Record<string, never>>(), () => "/x");

    const tool = tools[0];
    expect(tool).toBeDefined();
    let message = "";
    try {
      await tool?.handler({});
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // Truncated at 300, NOT the full 350-char body — pins the default.
    expect(message).toBe(`Svc 502: ${"x".repeat(300)}`);
  });

  it("throws when the token env is unset (requireProcessEnv fail-closed)", async () => {
    const tools: CapturedTool[] = [];
    const fetch = async (): Promise<HttpJsonBodyResponse> => ({
      ok: true,
      status: 200,
      json: {},
      text: "{}",
    });
    const register = makeRestToolRegistrar({
      registrar: makeCapturingRegistrar(tools),
      tokenEnv: TOKEN_ENV,
      serviceLabel: "Svc",
      fetch,
    });

    register("svc_get", "Get.", passthroughSchema<Record<string, never>>(), () => "/x");

    const tool = tools[0];
    expect(tool).toBeDefined();
    await expect(tool?.handler({})).rejects.toThrow(`${TOKEN_ENV} is not set`);
  });
});
