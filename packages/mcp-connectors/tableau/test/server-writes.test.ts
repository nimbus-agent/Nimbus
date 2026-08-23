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
  const t = new Map<string, Handler>();
  registerTableauTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      t.set(n, h as Handler),
    consentFakeServer((n, h) => t.set(n, h as Handler)),
  );
  return t;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("tableau write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; method: string }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["TABLEAU_URL"] = "https://tab.example.com";
    process.env["TABLEAU_PAT_NAME"] = "pat";
    process.env["TABLEAU_PAT_SECRET"] = "secret";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
          { status: 200 },
        );
      }
      calls.push({ url: u, method: String(init?.method) });
      return new Response(JSON.stringify({ job: { id: "job-9" } }), { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["TABLEAU_URL"];
    delete process.env["TABLEAU_PAT_NAME"];
    delete process.env["TABLEAU_PAT_SECRET"];
  });

  it("datasource refresh POSTs to the refresh endpoint and returns a queued job", async () => {
    const out = payload(
      await (captureTools().get("tableau_datasource_refresh") as Handler)({ id: "ds-1" }),
    );
    expect(out).toEqual({ status: "queued", jobId: "job-9" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/sites/site-1/datasources/ds-1/refresh");
  });

  it("workbook refresh targets the workbooks endpoint", async () => {
    await (captureTools().get("tableau_workbook_refresh") as Handler)({ id: "wb-2" });
    expect(calls[0]?.url).toContain("/sites/site-1/workbooks/wb-2/refresh");
    expect(calls[0]?.method).toBe("POST");
  });

  it("propagates non-ok status as a thrown error", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
          { status: 200 },
        );
      }
      calls.push({ url: u, method: String(init?.method) });
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("tableau_datasource_refresh") as Handler)({ id: "ds-err" }),
    ).rejects.toThrow("403");
  });

  it("throws (fail-closed) when job id is absent from the response", async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("/auth/signin")) {
        return new Response(
          JSON.stringify({ credentials: { token: "tok", site: { id: "site-1" } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ job: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("tableau_datasource_refresh") as Handler)({ id: "ds-2" }),
    ).rejects.toThrow(/missing job\.id/);
  });
});
