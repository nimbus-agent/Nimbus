import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerPowerBiTools } from "../src/server.ts";

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
  registerPowerBiTools(
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
      // Route by parsed host/path (not substring) so an attacker-shaped URL can't slip through —
      // CodeQL js/incomplete-url-substring-sanitization.
      const u = new URL(String(url));
      if (u.hostname === "login.microsoftonline.com") {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      if (u.pathname.endsWith("/v1.0/myorg/reports")) {
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
