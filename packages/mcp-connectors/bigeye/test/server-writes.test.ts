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

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("bigeye write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> =
    [];

  beforeEach(() => {
    calls = [];
    process.env["BIGEYE_BASE_URL"] = "https://bigeye.example.com";
    process.env["BIGEYE_API_KEY"] = "test-api-key";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["BIGEYE_BASE_URL"];
    delete process.env["BIGEYE_API_KEY"];
  });

  it("bigeye_issue_acknowledge POSTs to /api/v1/issues with ACKNOWLEDGED status and Bearer auth", async () => {
    const out = payload(
      await (captureTools().get("bigeye_issue_acknowledge") as Handler)({ issueId: "i1" }),
    );

    expect(out).toEqual({ status: "ok", issueId: "i1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://bigeye.example.com/api/v1/issues");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer test-api-key");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      issueId: "i1",
      status: "ISSUE_STATUS_ACKNOWLEDGED",
    });
  });

  it("bigeye_issue_resolve POSTs to /api/v1/issues with CLOSED status", async () => {
    const out = payload(
      await (captureTools().get("bigeye_issue_resolve") as Handler)({ issueId: "i2" }),
    );

    expect(out).toEqual({ status: "ok", issueId: "i2" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://bigeye.example.com/api/v1/issues");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      issueId: "i2",
      status: "ISSUE_STATUS_CLOSED",
    });
  });

  it("propagates non-ok response as a thrown error", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("bigeye_issue_acknowledge") as Handler)({ issueId: "bad" }),
    ).rejects.toThrow("401");
  });
});
