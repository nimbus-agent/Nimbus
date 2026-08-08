import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerTableauTools } from "../src/server.ts";

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
    it("throws if TABLEAU_URL is missing", async () => {
      delete process.env["TABLEAU_URL"];
      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow(
        "TABLEAU_URL is not set",
      );
    });

    it("throws if TABLEAU_PAT_NAME is missing", async () => {
      delete process.env["TABLEAU_PAT_NAME"];
      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow(
        "TABLEAU_PAT_NAME is not set",
      );
    });

    it("throws if TABLEAU_PAT_SECRET is missing", async () => {
      delete process.env["TABLEAU_PAT_SECRET"];
      const tools = captureTools();
      await expect(tool(tools, "tableau_get")({ id: "1" })).rejects.toThrow(
        "TABLEAU_PAT_SECRET is not set",
      );
    });
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
});
