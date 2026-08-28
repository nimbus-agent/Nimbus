import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const { runLlm, runLlmStatusImpl } = await import("./llm.ts");

const out = captureOutput();

afterAll(() => {
  out.restore();
});

const MOCK_ROUTES = [
  {
    routeId: "ollama/llama3.2",
    providerId: "ollama",
    modelName: "llama3.2",
    isLocal: true,
    available: true,
    reason: "ok",
    contextWindow: 128000,
  },
  {
    routeId: "ollama/gemma3:12b",
    providerId: "ollama",
    modelName: "gemma3:12b",
    isLocal: true,
    available: false,
    reason: "model_absent",
  },
];

describe("runLlmStatusImpl", () => {
  beforeEach(() => {
    out.reset();
  });

  it("prints one row per route with provider, model, and availability", async () => {
    const ipc = createMockIpcClient([{ routes: MOCK_ROUTES }]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(ipc.calls[0]).toEqual({ method: "llm.status", params: {} });
    expect(out.stdout).toContain("ollama/llama3.2");
    expect(out.stdout).toContain("ollama");
    expect(out.stdout).toContain("llama3.2");
    expect(out.stdout).toContain("yes");
    expect(out.stdout).toContain("128000");
  });

  it("distinguishes model_absent from provider_unreachable, never collapsing to bare 'unavailable'", async () => {
    const ipc = createMockIpcClient([
      {
        routes: [
          ...MOCK_ROUTES,
          {
            routeId: "llamacpp/model.gguf",
            providerId: "llamacpp",
            modelName: "model.gguf",
            isLocal: true,
            available: false,
            reason: "provider_unreachable",
          },
        ],
      },
    ]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(out.stdout).toContain("no (model not pulled)");
    expect(out.stdout).toContain("no (provider unreachable)");
    expect(out.stdout).not.toMatch(/\bunavailable\b/);
  });

  it("renders — for an undefined contextWindow, never a fabricated number", async () => {
    const ipc = createMockIpcClient([{ routes: MOCK_ROUTES }]);
    await runLlmStatusImpl(ipc.client, { json: false });
    const lines = out.stdout.split("\n");
    const gemmaLine = lines.find((l) => l.includes("ollama/gemma3:12b"));
    expect(gemmaLine).toBeDefined();
    // Ends with the context column: "—" for the absent-contextWindow route, never a
    // fabricated number (e.g. the OTHER route's real 128000 leaking in, or a made-up default).
    expect(gemmaLine?.trimEnd().endsWith("—")).toBe(true);
    expect(gemmaLine).not.toContain("128000");
  });

  it("shows a placeholder row when no routes are registered", async () => {
    const ipc = createMockIpcClient([{ routes: [] }]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(out.stdout).toContain("no routes registered");
  });

  it("reports a clear message when the payload has no routes array", async () => {
    // Unguarded this threw a raw TypeError on `.length` inside the table renderer.
    const ipc = createMockIpcClient([{}]);
    await expect(runLlmStatusImpl(ipc.client, { json: false })).rejects.toThrow(
      /no `routes` array/,
    );
  });

  it("reports a clear message when a ROW is malformed, rather than crashing in pad()", async () => {
    const ipc = createMockIpcClient([{ routes: [{ providerId: "ollama" }] }]);
    await expect(runLlmStatusImpl(ipc.client, { json: false })).rejects.toThrow(
      /route 0 is missing routeId/,
    );
    // Nothing half-rendered before the refusal.
    expect(out.stdout).not.toContain("ollama");
  });

  it("guards the envelope on the --json path too", async () => {
    const ipc = createMockIpcClient([{ routes: "not-an-array" }]);
    await expect(runLlmStatusImpl(ipc.client, { json: true })).rejects.toThrow(/no `routes` array/);
  });

  it("emits the route list faithfully as JSON, contextWindow omitted when absent", async () => {
    const ipc = createMockIpcClient([{ routes: MOCK_ROUTES }]);
    await runLlmStatusImpl(ipc.client, { json: true });
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      routeId: "ollama/llama3.2",
      providerId: "ollama",
      modelName: "llama3.2",
      isLocal: true,
      available: true,
      reason: "ok",
      contextWindow: 128000,
    });
    expect(parsed[1]).not.toHaveProperty("contextWindow");
    expect(parsed[1]).toMatchObject({ available: false, reason: "model_absent" });
  });
});

describe("not_configured — the remote-only availability reason", () => {
  beforeEach(() => {
    out.reset();
  });

  it("renders its own remedy, never a bare unavailable", async () => {
    // Three different fixes hide behind one word: start the daemon, pull the model, add a key.
    // Collapsing the third into `provider_unreachable` would send a user to check their network
    // for a missing credential.
    const ipc = createMockIpcClient([
      {
        routes: [
          {
            routeId: "openai/gpt-5",
            providerId: "openai",
            modelName: "gpt-5",
            isLocal: false,
            available: false,
            reason: "not_configured",
          },
        ],
      },
    ]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(out.stdout).toContain("no (no api key)");
    expect(out.stdout).not.toContain("provider unreachable");
    expect(out.stdout).not.toContain("model not pulled");
  });
});

describe("runLlm (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("prints help when no subcommand is given", async () => {
    await runLlm([]);
    expect(out.stdout).toContain("nimbus llm");
    expect(out.stdout).toContain("status");
  });

  it("prints help for help subcommand", async () => {
    await runLlm(["help"]);
    expect(out.stdout).toContain("nimbus llm");
  });

  it("throws for unknown subcommand", async () => {
    await expect(runLlm(["bogus"])).rejects.toThrow("Unknown llm subcommand: bogus");
  });

  it("runs status when gateway is running", async () => {
    const ipc = createMockIpcClient([{ routes: MOCK_ROUTES }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runLlm(["status"]);
    expect(ipc.calls[0]?.method).toBe("llm.status");
    expect(out.stdout).toContain("ollama/llama3.2");
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runLlm(["status"])).rejects.toThrow("Gateway is not running");
  });

  it("passes --json to status", async () => {
    const ipc = createMockIpcClient([{ routes: MOCK_ROUTES }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 1 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runLlm(["status", "--json"]);
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed[0]).toBeDefined();
  });
});
