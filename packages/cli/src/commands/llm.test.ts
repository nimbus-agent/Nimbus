import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const { runLlm, runLlmStatusImpl } = await import("./llm.ts");

const out = captureOutput();

afterAll(() => {
  out.restore();
});

const MOCK_DECISIONS = {
  classification: {
    providerId: "ollama",
    modelName: "llama3.2",
    isAvailable: true,
    reason: "prefer-local",
  },
  reasoning: {
    providerId: "ollama",
    modelName: "llama3.2",
    isAvailable: true,
    reason: "prefer-local",
  },
  summarisation: {
    providerId: "ollama",
    modelName: "llama3.2",
    isAvailable: true,
    reason: "prefer-local",
  },
  agent_step: undefined,
};

describe("runLlmStatusImpl", () => {
  beforeEach(() => {
    out.reset();
  });

  it("prints table with provider, model, availability, and reason", async () => {
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(ipc.calls[0]).toEqual({ method: "llm.status", params: {} });
    expect(out.stdout).toContain("classification");
    expect(out.stdout).toContain("ollama");
    expect(out.stdout).toContain("llama3.2");
    expect(out.stdout).toContain("yes");
    expect(out.stdout).toContain("prefer-local");
  });

  it("shows — and unavailable for undefined task decisions", async () => {
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(out.stdout).toContain("agent_step");
    expect(out.stdout).toContain("unavailable");
  });

  it("notes the fallback provider when the preferred provider is unavailable", async () => {
    const ipc = createMockIpcClient([
      {
        decisions: {
          ...MOCK_DECISIONS,
          classification: {
            providerId: "ollama",
            modelName: "llama3.2",
            isAvailable: false,
            reason: "prefer-local",
            fallback: { providerId: "remote", modelName: "claude-sonnet-4-6" },
          },
        },
      },
    ]);
    await runLlmStatusImpl(ipc.client, { json: false });
    expect(out.stdout).toContain("falls back to remote/claude-sonnet-4-6");
  });

  it("emits JSON when --json flag is set", async () => {
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    await runLlmStatusImpl(ipc.client, { json: true });
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed["classification"]).toMatchObject({
      providerId: "ollama",
      modelName: "llama3.2",
      isAvailable: true,
      reason: "prefer-local",
    });
  });

  it("JSON output always includes all four task types, using null for unavailable", async () => {
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    await runLlmStatusImpl(ipc.client, { json: true });
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort((a, b) => a.localeCompare(b))).toEqual([
      "agent_step",
      "classification",
      "reasoning",
      "summarisation",
    ]);
    expect(parsed["agent_step"]).toBeNull();
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
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runLlm(["status"]);
    expect(ipc.calls[0]?.method).toBe("llm.status");
    expect(out.stdout).toContain("classification");
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runLlm(["status"])).rejects.toThrow("Gateway is not running");
  });

  it("passes --json to status", async () => {
    const ipc = createMockIpcClient([{ decisions: MOCK_DECISIONS }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 1 },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runLlm(["status", "--json"]);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed["classification"]).toBeDefined();
  });
});
