import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerPowerBiTools } from "../src/server.ts";

type Handler = (args: unknown) => Promise<McpListResult>;

function captureTools(): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  registerPowerBiTools(
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

function parsePayload(res: McpListResult): { items: unknown[]; nextCursor: string | null } {
  return JSON.parse((res.content[0] as { text: string }).text) as {
    items: unknown[];
    nextCursor: string | null;
  };
}

describe("powerbi_list (single fetch + expanded dataset tables)", () => {
  const origFetch = globalThis.fetch;
  let reportsCalls = 0;

  beforeEach(() => {
    reportsCalls = 0;
    process.env["POWERBI_TENANT_ID"] = "tenant-1";
    process.env["POWERBI_CLIENT_ID"] = "client-1";
    process.env["POWERBI_CLIENT_SECRET"] = "secret-1";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function installFetch(): void {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (u.endsWith("/v1.0/myorg/reports")) {
        reportsCalls += 1;
        return new Response(
          JSON.stringify({
            value: [
              { id: "r1", name: "R1", datasetId: "ds1" },
              { id: "r2", name: "R2", datasetId: "ds2" },
            ],
          }),
          { status: 200 },
        );
      }
      // dataset tables endpoint: /datasets/{id}/tables
      return new Response(JSON.stringify({ value: [{ name: "analytics.public.orders" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  it("returns all reports with nextCursor=null and the reports endpoint hit exactly once", async () => {
    installFetch();
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "powerbi_list")({ cursor: null, limit: 200 }));

    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
    expect(reportsCalls).toBe(1);
  });

  it("expands each report with its dataset-table refs", async () => {
    installFetch();
    const tools = captureTools();
    const out = parsePayload(await tool(tools, "powerbi_list")({ cursor: null, limit: 200 }));

    for (const item of out.items) {
      const r = item as { datasetTables?: unknown };
      expect(Array.isArray(r.datasetTables)).toBe(true);
      expect(r.datasetTables).toContain("analytics.public.orders");
    }
  });
});
