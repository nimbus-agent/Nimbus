import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerTableauTools, startConnector } from "../src/server.ts";

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

function parsePayload(res: McpListResult): {
  items?: unknown[];
  nextCursor?: string | null;
  luid?: string;
  name?: string;
  matches?: unknown[];
} {
  return JSON.parse((res.content[0] as { text: string }).text) as {
    items?: unknown[];
    nextCursor?: string | null;
    luid?: string;
    name?: string;
    matches?: unknown[];
  };
}

describe("tableau server", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    process.env["TABLEAU_URL"] = "https://tab.example.com";
    process.env["TABLEAU_PAT_NAME"] = "pat";
    process.env["TABLEAU_PAT_SECRET"] = "secret";
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["TABLEAU_URL"];
    delete process.env["TABLEAU_PAT_NAME"];
    delete process.env["TABLEAU_PAT_SECRET"];
  });

  describe("environment variable validation", () => {
    // Each required variable, dropped one at a time. The error must NAME the
    // missing variable — a generic "not configured" would leave an operator
    // guessing which of the three they forgot.
    it.each(["TABLEAU_URL", "TABLEAU_PAT_NAME", "TABLEAU_PAT_SECRET"])(
      "throws if %s is missing",
      async (varName) => {
        delete process.env[varName];
        const tools = captureTools();
        await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow(
          `${varName} is not set`,
        );
      },
    );
  });

  describe("signin errors", () => {
    it("throws on non-ok signin response", async () => {
      globalThis.fetch = (async (_url: string) => {
        return new Response("Unauthorized", { status: 401 });
      }) as unknown as typeof fetch;

      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow("Tableau signin 401");
    });

    it("throws on missing token or site id", async () => {
      globalThis.fetch = (async (_url: string) => {
        return new Response(JSON.stringify({ credentials: { site: { id: "site-1" } } }), {
          status: 200,
        }); // missing token
      }) as unknown as typeof fetch;

      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow(
        "missing credentials.token or credentials.site.id",
      );
    });
  });

  describe("tableau_get", () => {
    it("returns view successfully by luid", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response(
            JSON.stringify({ views: { view: [{ luid: "view-123", name: "My View" }] } }),
            { status: 200 },
          );
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      const out = parsePayload(await tool(tools, "tableau_get")({ id: "view-123" }));
      expect(out).toEqual({ luid: "view-123", name: "My View" });
    });

    it("throws if view not found", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response(
            JSON.stringify({ views: { view: [{ luid: "view-123", name: "My View" }] } }),
            { status: 200 },
          );
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "non-existent" })).rejects.toThrow(
        "Tableau view not found: non-existent",
      );
    });

    it("throws on non-ok views response", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response("Bad Request", { status: 400 });
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "view-123" })).rejects.toThrow(
        "Tableau views 400",
      );
    });
  });

  describe("tableau_list", () => {
    it("returns views successfully", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response(
            JSON.stringify({
              views: { view: [{ luid: "view-123", name: "My View" }] },
              pagination: { totalAvailable: 1 },
            }),
            { status: 200 },
          );
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      const out = parsePayload(await tool(tools, "tableau_list")({ cursor: null, limit: 10 }));
      expect(out.items).toHaveLength(1);
      expect(out.items![0]).toEqual({ luid: "view-123", name: "My View" });
      expect(out.nextCursor).toBeNull();
    });

    it("returns non-terminal nextCursor pagination successfully", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response(
            JSON.stringify({
              views: { view: [{ luid: "view-123", name: "My View" }] },
              pagination: { totalAvailable: 11 },
            }),
            { status: 200 },
          );
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      const out = parsePayload(await tool(tools, "tableau_list")({ cursor: null, limit: 10 }));
      expect(out.items).toHaveLength(1);
      expect(out.nextCursor).toBe("2");
    });

    it("throws on non-ok views response", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response("Bad Request", { status: 400 });
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      await expect(tool(tools, "tableau_list")({ cursor: null, limit: 10 })).rejects.toThrow(
        "Tableau views 400",
      );
    });
  });

  describe("tableau_search", () => {
    it("returns matched views successfully", async () => {
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes("/auth/signin")) {
          return new Response(
            JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
            { status: 200 },
          );
        }
        if (u.includes("/views")) {
          return new Response(
            JSON.stringify({
              views: {
                view: [
                  { luid: "v1", name: "Sales" },
                  { luid: "v2", name: "Marketing" },
                ],
              },
            }),
            { status: 200 },
          );
        }
        throw new Error("unexpected url");
      }) as unknown as typeof fetch;

      const tools = captureTools();
      const out = parsePayload(await tool(tools, "tableau_search")({ query: "sale", limit: 10 }));
      expect(out.matches).toHaveLength(1);
      expect(out.matches![0]).toEqual({ luid: "v1", name: "Sales" });
    });
  });

  describe("startConnector", () => {
    it("starts a read-only server with tableau tools", async () => {
      const mockRun = mock((_name: string, _reg: unknown) => Promise.resolve());
      mock.module("../../shared/run-read-only-mcp-connector.ts", () => ({
        runReadOnlyMcpConnector: mockRun,
      }));

      await startConnector();
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun.mock.calls[0]?.[0]).toBe("nimbus-tableau");
      expect(mockRun.mock.calls[0]?.[1]).toBe(registerTableauTools);
    });
  });
});
