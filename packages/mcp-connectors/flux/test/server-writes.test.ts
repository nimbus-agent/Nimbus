import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConnectorModeForTests, setConnectorMode } from "../../shared/connector-mode.ts";
import type { McpListResult, ZodObjectSchema } from "../../shared/mcp-tool-kit.ts";
import { registerFluxTools } from "../src/server.ts";

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
  registerFluxTools(
    <T>(n: string, _d: string, _s: ZodObjectSchema<T>, h: (a: T) => Promise<McpListResult>) =>
      tools.set(n, h as Handler),
    consentFakeServer((n, h) => tools.set(n, h as Handler)),
  );
  return tools;
}

function payload(res: McpListResult): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("flux reconcile write tools", () => {
  const origFetch = globalThis.fetch;
  let calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["FLUX_API_URL"] = "https://k8s.example.com";
    process.env["FLUX_TOKEN"] = "tok";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ kind: "Kustomization" }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env["FLUX_API_URL"];
    delete process.env["FLUX_TOKEN"];
  });

  it("flux_kustomization_reconcile PATCHes the CR with the requestedAt annotation", async () => {
    const out = payload(
      await (captureTools().get("flux_kustomization_reconcile") as Handler)({
        namespace: "flux-system",
        name: "apps",
      }),
    );
    expect(out["status"]).toBe("requested");
    expect(calls[0]?.url).toContain("/apis/kustomize.toolkit.fluxcd.io/");
    expect(calls[0]?.url.endsWith("/namespaces/flux-system/kustomizations/apps")).toBe(true);
    expect(calls[0]?.init?.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      metadata: { annotations: Record<string, string> };
    };
    expect(body.metadata.annotations["reconcile.fluxcd.io/requestedAt"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it("flux_helmrelease_reconcile PATCHes the helm.toolkit.fluxcd.io CR", async () => {
    await (captureTools().get("flux_helmrelease_reconcile") as Handler)({
      namespace: "apps",
      name: "redis",
    });
    expect(calls[0]?.url).toContain("/apis/helm.toolkit.fluxcd.io/");
    expect(calls[0]?.url.endsWith("/namespaces/apps/helmreleases/redis")).toBe(true);
  });

  it("flux_kustomization_reconcile throws on a non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(
      (captureTools().get("flux_kustomization_reconcile") as Handler)({
        namespace: "flux-system",
        name: "apps",
      }),
    ).rejects.toThrow(/403/);
  });
});
