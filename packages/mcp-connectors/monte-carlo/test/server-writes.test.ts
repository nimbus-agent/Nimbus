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

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

interface Captured {
  url: string;
  method: string;
  query: string;
  variables: Record<string, unknown>;
}

describe("monte carlo write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: Captured[] = [];

  beforeEach(() => {
    calls = [];
    process.env["MONTECARLO_API_ID"] = "id";
    process.env["MONTECARLO_API_TOKEN"] = "token";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push({
        url: String(url),
        method: String(init?.method),
        query: body.query,
        variables: body.variables,
      });
      return new Response(
        JSON.stringify({ data: { setIncidentFeedback: { __typename: "SetIncidentFeedback" } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["MONTECARLO_API_ID"];
    delete process.env["MONTECARLO_API_TOKEN"];
  });

  it("acknowledge POSTs setIncidentFeedback with ACKNOWLEDGED feedback", async () => {
    const out = payload(
      await tool(captureTools(), "montecarlo_incident_acknowledge")({ incidentId: "i1" }),
    );
    expect(out).toEqual({ status: "ok", incidentId: "i1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("api.getmontecarlo.com/graphql");
    expect(calls[0]?.query).toContain("setIncidentFeedback");
    expect(calls[0]?.variables).toEqual({ incidentId: "i1", feedback: "ACKNOWLEDGED" });
  });

  it("resolve POSTs setIncidentFeedback with RESOLVED feedback", async () => {
    const out = payload(
      await tool(captureTools(), "montecarlo_incident_resolve")({ incidentId: "i2" }),
    );
    expect(out).toEqual({ status: "ok", incidentId: "i2" });
    expect(calls[0]?.variables).toEqual({ incidentId: "i2", feedback: "RESOLVED" });
  });

  it("throws on a GraphQL errors response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "incident not found" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      tool(captureTools(), "montecarlo_incident_acknowledge")({ incidentId: "bad" }),
    ).rejects.toThrow("incident not found");
  });

  it("throws on a non-ok HTTP response", async () => {
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(
      tool(captureTools(), "montecarlo_incident_resolve")({ incidentId: "i3" }),
    ).rejects.toThrow("403");
  });
});
