import { describe, expect, it } from "bun:test";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  fetchWithTimeout,
  type HttpJsonBodyResponse,
  type HttpTextResponse,
  mcpJsonResult,
  mcpJsonResultFromTextIfOk,
  mcpJsonResultIfOk,
  parseJsonTextIfOk,
  putOptionalBoolean,
  putOptionalNonEmptyString,
  type RegisterSimpleToolFn,
  registerZodTool,
  requireProcessEnv,
  type ZodObjectSchema,
} from "./mcp-tool-kit.ts";

function parseText(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "");
}

describe("mcpJsonResult", () => {
  it("wraps data as pretty-printed JSON text content", () => {
    const r = mcpJsonResult({ a: 1, b: ["x"] });
    expect(r.content[0]?.type).toBe("text");
    expect(parseText(r)).toEqual({ a: 1, b: ["x"] });
    expect(r.content[0]?.text).toContain("\n"); // pretty-printed (indent)
  });
});

function okSchema<T>(data: T): ZodObjectSchema<T> {
  return { shape: { q: {} }, safeParse: () => ({ success: true, data }) };
}
function failSchema(message: string): ZodObjectSchema<never> {
  return { shape: {}, safeParse: () => ({ success: false, error: { message } }) };
}

describe("registerZodTool / createZodToolRegistrar", () => {
  it("registers a tool that safeParses then calls the handler on success", async () => {
    const calls: Array<{ name: string; shape: unknown }> = [];
    let captured: unknown;
    const register: RegisterSimpleToolFn = (name, _desc, shape, handler) => {
      calls.push({ name, shape });
      captured = handler;
      return undefined;
    };
    registerZodTool(register, "t1", "desc", okSchema({ v: 5 }), async (args) =>
      mcpJsonResult(args),
    );
    expect(calls[0]?.name).toBe("t1");
    const run = captured as (a: unknown) => Promise<ReturnType<typeof mcpJsonResult>>;
    expect(parseText(await run({}))).toEqual({ v: 5 });
  });

  it("throws the zod error message when safeParse fails", async () => {
    let captured: unknown;
    const register: RegisterSimpleToolFn = (_n, _d, _s, handler) => {
      captured = handler;
      return undefined;
    };
    registerZodTool(register, "t2", "d", failSchema("bad input"), async () => mcpJsonResult({}));
    const run = captured as (a: unknown) => Promise<unknown>;
    await expect(run({})).rejects.toThrow("bad input");
  });

  it("createZodToolRegistrar produces an equivalent registrar", async () => {
    let captured: unknown;
    const register: RegisterSimpleToolFn = (_n, _d, _s, handler) => {
      captured = handler;
      return undefined;
    };
    const registrar = createZodToolRegistrar(register);
    registrar("t3", "d", okSchema({ ok: true }), async (a) => mcpJsonResult(a));
    const run = captured as (a: unknown) => Promise<ReturnType<typeof mcpJsonResult>>;
    expect(parseText(await run({}))).toEqual({ ok: true });
  });
});

describe("mcpJsonResultIfOk", () => {
  it("wraps json when ok", () => {
    const res: HttpJsonBodyResponse = { ok: true, status: 200, json: { a: 1 }, text: "" };
    expect(parseText(mcpJsonResultIfOk("svc", res))).toEqual({ a: 1 });
  });
  it("throws with status + truncated snippet when not ok", () => {
    const res: HttpJsonBodyResponse = { ok: false, status: 503, json: null, text: "x".repeat(500) };
    expect(() => mcpJsonResultIfOk("svc", res, 10)).toThrow("svc 503: xxxxxxxxxx");
  });
});

describe("mcpJsonResultFromTextIfOk", () => {
  it("parses and wraps JSON text when ok", () => {
    const res: HttpTextResponse = { ok: true, status: 200, text: '{"k":2}' };
    expect(parseText(mcpJsonResultFromTextIfOk("svc", res))).toEqual({ k: 2 });
  });
  it("throws status + snippet when not ok", () => {
    const res: HttpTextResponse = { ok: false, status: 404, text: "missing" };
    expect(() => mcpJsonResultFromTextIfOk("svc", res)).toThrow("svc 404: missing");
  });
  it("throws the default invalid-JSON message on parse failure", () => {
    const res: HttpTextResponse = { ok: true, status: 200, text: "not json" };
    expect(() => mcpJsonResultFromTextIfOk("svc", res)).toThrow("svc: invalid JSON response");
  });
  it("throws the custom jsonParseErrorMessage when provided", () => {
    const res: HttpTextResponse = { ok: true, status: 200, text: "not json" };
    expect(() =>
      mcpJsonResultFromTextIfOk("svc", res, { jsonParseErrorMessage: "Jira parse failed" }),
    ).toThrow("Jira parse failed");
  });
});

describe("parseJsonTextIfOk", () => {
  it("returns parsed JSON when ok", () => {
    expect(parseJsonTextIfOk("svc", { ok: true, status: 200, text: "[1,2]" })).toEqual([1, 2]);
  });
  it("throws when not ok", () => {
    expect(() => parseJsonTextIfOk("svc", { ok: false, status: 500, text: "err" })).toThrow(
      "svc 500: err",
    );
  });
});

describe("putOptionalNonEmptyString / putOptionalBoolean", () => {
  it("sets a non-empty string and skips undefined/empty", () => {
    const body: Record<string, unknown> = {};
    putOptionalNonEmptyString(body, "a", "x");
    putOptionalNonEmptyString(body, "b", "");
    putOptionalNonEmptyString(body, "c", undefined);
    expect(body).toEqual({ a: "x" });
  });
  it("sets booleans (including false) and skips undefined", () => {
    const body: Record<string, unknown> = {};
    putOptionalBoolean(body, "t", true);
    putOptionalBoolean(body, "f", false);
    putOptionalBoolean(body, "u", undefined);
    expect(body).toEqual({ t: true, f: false });
  });
});

describe("createRegisterSimpleTool", () => {
  it("binds server.tool when present", () => {
    const seen: unknown[] = [];
    const server = {
      tool(this: unknown, ...args: unknown[]) {
        seen.push(args);
        return "registered";
      },
    };
    const fn = createRegisterSimpleTool(server);
    const out = fn("n", "d", {}, async () => mcpJsonResult({}));
    expect(out).toBe("registered");
    expect(seen).toHaveLength(1);
  });
  it("throws when the server has no .tool function", () => {
    expect(() => createRegisterSimpleTool(null)).toThrow("expected MCP server with .tool");
    expect(() => createRegisterSimpleTool({})).toThrow("expected MCP server with .tool");
    expect(() => createRegisterSimpleTool({ tool: 1 })).toThrow("expected MCP server with .tool");
  });
});

describe("requireProcessEnv", () => {
  const KEY = "NIMBUS_MCP_TOOL_KIT_TEST_VAR";
  it("returns the value when set", () => {
    process.env[KEY] = "present";
    try {
      expect(requireProcessEnv(KEY)).toBe("present");
    } finally {
      delete process.env[KEY];
    }
  });
  it("throws when unset or empty", () => {
    delete process.env[KEY];
    expect(() => requireProcessEnv(KEY)).toThrow(`${KEY} is not set`);
    process.env[KEY] = "";
    try {
      expect(() => requireProcessEnv(KEY)).toThrow(`${KEY} is not set`);
    } finally {
      delete process.env[KEY];
    }
  });
});

describe("encodeBasicAuthHeader", () => {
  it("produces a Basic header from email:token", () => {
    const header = encodeBasicAuthHeader("a@b.com", "tok");
    expect(header).toBe(`Basic ${Buffer.from("a@b.com:tok", "utf8").toString("base64")}`);
    expect(header.startsWith("Basic ")).toBe(true);
  });
});

describe("fetchWithTimeout", () => {
  it("resolves with the response when fetch completes before the timeout", async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = (async (_input: string | URL, _init?: RequestInit) =>
        new Response("ok", { status: 200 })) as typeof fetch;
      const res = await fetchWithTimeout("https://example.com/api", {}, 5_000);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("aborts with a DOMException when the timeout fires before fetch resolves", async () => {
    const orig = globalThis.fetch;
    try {
      globalThis.fetch = ((_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Propagate the abort signal so the promise rejects on abort
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })) as typeof fetch;
      await expect(fetchWithTimeout("https://example.com/slow", {}, 1)).rejects.toThrow();
    } finally {
      globalThis.fetch = orig;
    }
  });
});
