import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerLookerTools } from "../src/server.ts";

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
  registerLookerTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      t.set(n, h as Handler),
    consentFakeServer((n, h) => t.set(n, h as Handler)),
  );
  return t;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("looker write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; method: string; body: string }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["LOOKER_BASE_URL"] = "https://looker.example.com";
    process.env["LOOKER_CLIENT_ID"] = "id";
    process.env["LOOKER_CLIENT_SECRET"] = "secret";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/4.0/login")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      calls.push({ url: u, method: String(init?.method), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["LOOKER_BASE_URL"];
    delete process.env["LOOKER_CLIENT_ID"];
    delete process.env["LOOKER_CLIENT_SECRET"];
  });

  it("looker_datagroup_trigger: PATCHes the datagroup endpoint with stale_before and returns ok", async () => {
    const out = payload(
      await (captureTools().get("looker_datagroup_trigger") as Handler)({ datagroupId: "dg-1" }),
    );
    expect(out).toEqual({ status: "ok", datagroupId: "dg-1" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain("/datagroups/dg-1");
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(typeof body["stale_before"]).toBe("number");
  });

  it("looker_schedule_run_once: POSTs to run_once endpoint and returns queued", async () => {
    const out = payload(
      await (captureTools().get("looker_schedule_run_once") as Handler)({
        scheduledPlanId: "sp-2",
      }),
    );
    expect(out).toEqual({ status: "queued", scheduledPlanId: "sp-2" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/scheduled_plans/sp-2/run_once");
  });

  it("looker_datagroup_trigger: propagates non-ok status as a thrown error", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/4.0/login")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      calls.push({ url: u, method: String(init?.method), body: String(init?.body ?? "") });
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("looker_datagroup_trigger") as Handler)({ datagroupId: "dg-err" }),
    ).rejects.toThrow("403");
  });

  it("looker_schedule_run_once: propagates non-ok status as a thrown error", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/4.0/login")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      }
      calls.push({ url: u, method: String(init?.method), body: String(init?.body ?? "") });
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      (captureTools().get("looker_schedule_run_once") as Handler)({ scheduledPlanId: "sp-err" }),
    ).rejects.toThrow("404");
  });
});
