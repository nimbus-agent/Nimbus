import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerMonteCarloTools } from "../src/server.ts";

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
  registerMonteCarloTools(
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

function incidentsPage(
  ids: string[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      getIncidents: {
        edges: ids.map((id) => ({ node: { incidentId: id } })),
        pageInfo,
      },
    },
  });
}

describe("montecarlo_list relay pagination", () => {
  const origFetch = globalThis.fetch;
  let afterVars: Array<string | null> = [];

  beforeEach(() => {
    afterVars = [];
    process.env["MONTECARLO_API_ID"] = "id";
    process.env["MONTECARLO_API_TOKEN"] = "token";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installFetch(
    page: (after: string | null) => {
      ids: string[];
      hasNextPage: boolean;
      endCursor: string | null;
    },
  ): void {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { variables?: { after?: string | null } };
      const after = body.variables?.after ?? null;
      afterVars.push(after);
      const { ids, hasNextPage, endCursor } = page(after);
      return new Response(incidentsPage(ids, { hasNextPage, endCursor }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("threads the after cursor and advances nextCursor while hasNextPage", async () => {
    installFetch(() => ({ ids: ["i1", "i2"], hasNextPage: true, endCursor: "c2" }));
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "montecarlo_list")({ limit: 2, cursor: null }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("c2");
    expect(afterVars[0]).toBeNull(); // first page → no after
  });

  it("returns nextCursor=null when hasNextPage is false; threads the given after", async () => {
    installFetch(() => ({ ids: ["i3"], hasNextPage: false, endCursor: "c3" }));
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "montecarlo_list")({ limit: 2, cursor: "c2" }));

    expect(out.nextCursor).toBeNull();
    expect(afterVars[0]).toBe("c2");
  });
});
