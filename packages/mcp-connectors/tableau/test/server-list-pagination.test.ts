import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerTableauTools } from "../src/server.ts";

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
  registerTableauTools(
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

function viewsResponse(viewNames: string[], totalAvailable: number): string {
  return JSON.stringify({
    views: { view: viewNames.map((n) => ({ luid: n, name: n })) },
    pagination: { totalAvailable: String(totalAvailable) },
  });
}

function parsePayload(res: McpListResult): { items: unknown[]; nextCursor: string | null } {
  return JSON.parse((res.content[0] as { text: string }).text) as {
    items: unknown[];
    nextCursor: string | null;
  };
}

describe("tableau_list pagination", () => {
  const origFetch = globalThis.fetch;
  let viewUrls: string[] = [];

  beforeEach(() => {
    viewUrls = [];
    process.env["TABLEAU_URL"] = "https://tab.example.com";
    process.env["TABLEAU_PAT_NAME"] = "pat";
    process.env["TABLEAU_PAT_SECRET"] = "secret";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installFetch(page: (pageNumber: number) => { names: string[]; total: number }): void {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
          { status: 200 },
        );
      }
      viewUrls.push(u);
      const pageNumber = Number(new URL(u).searchParams.get("pageNumber"));
      const { names, total } = page(pageNumber);
      return new Response(viewsResponse(names, total), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("sends pageSize/pageNumber and advances nextCursor while pages remain (1-based)", async () => {
    installFetch(() => ({ names: ["A", "B"], total: 3 }));
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "tableau_list")({ limit: 2, cursor: null }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("2"); // page 1 of 2, 1*2 < 3
    const q = new URL(viewUrls[0] as string).searchParams;
    expect(q.get("pageSize")).toBe("2");
    expect(q.get("pageNumber")).toBe("1");
  });

  it("returns nextCursor=null on the final (short) page", async () => {
    installFetch(() => ({ names: ["C"], total: 3 }));
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "tableau_list")({ limit: 2, cursor: "2" }));

    expect(out.nextCursor).toBeNull(); // page 2: 2*2 = 4, not < 3
    expect(new URL(viewUrls[0] as string).searchParams.get("pageNumber")).toBe("2");
  });

  it("maps cursor null and '0' both to pageNumber=1 (never page 0)", async () => {
    installFetch(() => ({ names: ["A", "B"], total: 4 }));
    const tools = captureTools();

    await tool(tools, "tableau_list")({ limit: 2, cursor: null });
    await tool(tools, "tableau_list")({ limit: 2, cursor: "0" });

    expect(new URL(viewUrls[0] as string).searchParams.get("pageNumber")).toBe("1");
    expect(new URL(viewUrls[1] as string).searchParams.get("pageNumber")).toBe("1");
  });

  it("clamps a negative or non-finite cursor to pageNumber=1", async () => {
    installFetch(() => ({ names: ["A"], total: 1 }));
    const tools = captureTools();

    await tool(tools, "tableau_list")({ limit: 2, cursor: "-5" }); // negative → 1
    await tool(tools, "tableau_list")({ limit: 2, cursor: "Infinity" }); // non-finite → 1
    await tool(tools, "tableau_list")({ limit: 2, cursor: "abc" }); // NaN → 1

    for (const u of viewUrls) {
      expect(new URL(u).searchParams.get("pageNumber")).toBe("1");
    }
  });
});
