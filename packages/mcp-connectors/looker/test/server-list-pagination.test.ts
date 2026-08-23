import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerLookerTools } from "../src/server.ts";

// These cases assert the TOOL SURFACE, not the consent gate. Gateway mode is the shape they were
// written against: the connector registers everything and executor.ts (I2) is the gate. Reset on
// BOTH sides — bun test runs many files in ONE process.
beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("gateway");
});
afterEach(() => {
  resetConnectorModeForTests();
});

/**
 * Minimal server for the consent kit. In gateway mode it never reads the capability surface, but
 * it DOES register through `registerTool` — so this records into the same sink the read registrar
 * fills, or the connector's write tools would vanish from the captured surface.
 */
function consentFakeServer(sink: (name: string, handler: unknown) => void): never {
  return {
    server: { getClientCapabilities: () => undefined },
    registerTool: (name: string, _cfg: unknown, handler: unknown) => {
      sink(name, handler);
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
  } as unknown as never;
}

type Handler = (args: unknown) => Promise<McpListResult>;

function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerLookerTools(
    <T>(
      name: string,
      _desc: string,
      _schema: ZodObjectSchema<T>,
      handler: (args: T) => Promise<McpListResult>,
    ) => {
      tools.set(name, handler as Handler);
    },
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

function tool(tools: Map<string, Handler>, name: string): Handler {
  const handler = tools.get(name);
  if (handler === undefined) throw new Error(`tool not registered: ${name}`);
  return handler;
}

function parsePayload(res: McpListResult): { items: unknown[]; nextCursor: string | null } {
  return JSON.parse((res.content[0] as { text: string }).text) as {
    items: unknown[];
    nextCursor: string | null;
  };
}

describe("looker list pagination", () => {
  const origFetch = globalThis.fetch;
  let urls: string[] = [];

  beforeEach(() => {
    urls = [];
    process.env["LOOKER_BASE_URL"] = "https://looker.example.com";
    process.env["LOOKER_CLIENT_ID"] = "id";
    process.env["LOOKER_CLIENT_SECRET"] = "secret";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installFetch(rows: (offset: number) => unknown[]): void {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/api/4.0/login")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      urls.push(u);
      const offset = Number(new URL(u).searchParams.get("offset"));
      return new Response(JSON.stringify(rows(offset)), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("looker_list: sends limit/offset and advances nextCursor on a full page", async () => {
    installFetch(() => [{ id: "d1" }, { id: "d2" }]);
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "looker_list")({ limit: 2, cursor: null }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("2"); // full page (length === limit)
    const q = new URL(urls[0] as string).searchParams;
    expect(q.get("limit")).toBe("2");
    expect(q.get("offset")).toBe("0");
  });

  it("looker_list: nextCursor=null on a short page; cursor maps to offset", async () => {
    installFetch(() => [{ id: "d3" }]);
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "looker_list")({ limit: 2, cursor: "4" }));

    expect(out.nextCursor).toBeNull();
    expect(new URL(urls[0] as string).searchParams.get("offset")).toBe("4");
  });

  it("looker_models_list: paginates LookML models with limit/offset", async () => {
    installFetch((offset) => (offset === 0 ? [{ name: "m1" }, { name: "m2" }] : [{ name: "m3" }]));
    const tools = captureTools();

    const p1 = parsePayload(await tool(tools, "looker_models_list")({ limit: 2, cursor: null }));
    expect(p1.items).toEqual([{ name: "m1" }, { name: "m2" }]);
    expect(p1.nextCursor).toBe("2");
    expect(new URL(urls[0] as string).pathname).toBe("/api/4.0/lookml_models");

    const p2 = parsePayload(await tool(tools, "looker_models_list")({ limit: 2, cursor: "2" }));
    expect(p2.items).toEqual([{ name: "m3" }]);
    expect(p2.nextCursor).toBeNull();
  });
});
