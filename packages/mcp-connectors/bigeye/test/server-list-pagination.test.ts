import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerBigeyeTools } from "../src/server.ts";

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
  registerBigeyeTools(
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

describe("bigeye_list offset pagination", () => {
  const origFetch = globalThis.fetch;
  let queries: Array<{ limit: string | null; offset: string | null }> = [];

  beforeEach(() => {
    queries = [];
    process.env["BIGEYE_BASE_URL"] = "https://bigeye.example.com";
    process.env["BIGEYE_API_KEY"] = "key";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installFetch(issues: unknown[]): void {
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      queries.push({ limit: u.searchParams.get("limit"), offset: u.searchParams.get("offset") });
      return new Response(JSON.stringify({ issues }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("advances nextCursor by limit on a full page; sends limit/offset query params", async () => {
    installFetch([{ issueId: "1" }, { issueId: "2" }]); // full page of 2 (=== limit)
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "bigeye_list")({ limit: 2, cursor: null }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("2");
    expect(queries[0]).toEqual({ limit: "2", offset: "0" });
  });

  it("returns nextCursor=null on a short page and threads the given offset", async () => {
    installFetch([{ issueId: "3" }]); // short page (1 < limit 2)
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "bigeye_list")({ limit: 2, cursor: "2" }));

    expect(out.nextCursor).toBeNull();
    expect(queries[0]).toEqual({ limit: "2", offset: "2" });
  });
});
