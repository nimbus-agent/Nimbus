import { describe, expect, mock, test } from "bun:test";
import type { LlmRegistry } from "../llm/registry.ts";
import type { LlmModelInfo } from "../llm/types.ts";
import type { LlmRpcContext } from "./llm-rpc.ts";
import { dispatchLlmRpc } from "./llm-rpc.ts";

function makeFakeRegistry(models: LlmModelInfo[] = []): LlmRpcContext["registry"] {
  return {
    listAllModels: async () => models,
    checkAvailability: async () => ({ ollama: true, llamacpp: false }),
  } as unknown as LlmRpcContext["registry"];
}

describe("dispatchLlmRpc", () => {
  test("returns miss for unknown method", async () => {
    const ctx: LlmRpcContext = { registry: makeFakeRegistry(), notify: () => {} };
    const result = await dispatchLlmRpc("unknown.method", {}, ctx);
    expect(result.kind).toBe("miss");
  });

  test("returns miss for non-llm prefix", async () => {
    const ctx: LlmRpcContext = { registry: makeFakeRegistry(), notify: () => {} };
    const result = await dispatchLlmRpc("connector.list", {}, ctx);
    expect(result.kind).toBe("miss");
  });

  test("llm.listModels returns model list", async () => {
    const models: LlmModelInfo[] = [
      { provider: "ollama", modelName: "llama3.2", contextWindow: 128000 },
    ];
    const ctx: LlmRpcContext = { registry: makeFakeRegistry(models), notify: () => {} };
    const result = await dispatchLlmRpc("llm.listModels", {}, ctx);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      const value = result.value as { models: LlmModelInfo[] };
      expect(value.models).toHaveLength(1);
      expect(value.models[0]?.modelName ?? "").toBe("llama3.2");
    }
  });

  test("llm.getStatus returns availability map", async () => {
    const ctx: LlmRpcContext = { registry: makeFakeRegistry(), notify: () => {} };
    const result = await dispatchLlmRpc("llm.getStatus", {}, ctx);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      const value = result.value as { available: Record<string, boolean> };
      expect(value.available["ollama"]).toBe(true);
      expect(value.available["llamacpp"]).toBe(false);
    }
  });
});

describe("llm.pullModel", () => {
  test("returns { pullId } and calls registry.pullModel", async () => {
    const pullModel = mock(async () => {});
    const registry = { pullModel } as unknown as LlmRegistry;
    const notify = mock((_m: string, _p: unknown) => {});
    const result = await dispatchLlmRpc(
      "llm.pullModel",
      { provider: "ollama", modelName: "gemma:2b" },
      { registry, notify },
    );
    expect(result.kind).toBe("hit");
    expect((result as { kind: "hit"; value: { pullId: string } }).value.pullId).toMatch(/^pull_/);
    expect(pullModel).toHaveBeenCalledTimes(1);
  });

  test("rejects unknown provider with -32602", async () => {
    const registry = { pullModel: mock(async () => {}) } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.pullModel",
        { provider: "remote", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });
});

describe("llm.cancelPull", () => {
  test("returns cancelled:false for unknown pullId", async () => {
    const r = await dispatchLlmRpc(
      "llm.cancelPull",
      { pullId: "pull_unknown_000" },
      { registry: {} as unknown as LlmRegistry, notify: () => {} },
    );
    expect(r.kind).toBe("hit");
    expect((r as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(false);
  });

  test("rejects missing pullId with -32602", async () => {
    await expect(
      dispatchLlmRpc("llm.cancelPull", null, {
        registry: {} as unknown as LlmRegistry,
        notify: () => {},
      }),
    ).rejects.toThrow();
  });
});

describe("llm.loadModel / llm.unloadModel", () => {
  test("loadModel marks the model as loaded and returns isLoaded: true", async () => {
    const loadModel = mock(async () => {});
    const registry = { loadModel } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc(
      "llm.loadModel",
      { provider: "ollama", modelName: "gemma:2b" },
      { registry, notify: () => {} },
    );
    expect(r.kind).toBe("hit");
    expect((r as { kind: "hit"; value: { isLoaded: boolean } }).value.isLoaded).toBe(true);
    expect(loadModel).toHaveBeenCalledWith("ollama", "gemma:2b");
  });

  test("unloadModel returns isLoaded: false", async () => {
    const unloadModel = mock(async () => {});
    const registry = { unloadModel } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc(
      "llm.unloadModel",
      { provider: "ollama", modelName: "gemma:2b" },
      { registry, notify: () => {} },
    );
    expect((r as { kind: "hit"; value: { isLoaded: boolean } }).value.isLoaded).toBe(false);
    expect(unloadModel).toHaveBeenCalledWith("ollama", "gemma:2b");
  });

  test("loadModel rejects unsupported provider", async () => {
    const registry = { loadModel: mock(async () => {}) } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.loadModel",
        { provider: "remote", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });
});

describe("llm.getRouterStatus", () => {
  test("returns a routing decision per task type", async () => {
    const getRouterStatus = mock(async () => ({
      classification: { providerId: "ollama", modelName: "gemma:2b", reason: "default" },
      reasoning: { providerId: "remote", modelName: "claude", reason: "air-gap off" },
      summarisation: { providerId: "ollama", modelName: "llama3.2", reason: "default" },
      agent_step: { providerId: "ollama", modelName: "llama3.2", reason: "default" },
    }));
    const registry = { getRouterStatus } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.getRouterStatus", null, { registry, notify: () => {} });
    expect(r.kind).toBe("hit");
    const val = (r as { kind: "hit"; value: { decisions: Record<string, unknown> } }).value;
    expect(Object.keys(val.decisions).sort((a, b) => a.localeCompare(b))).toEqual([
      "agent_step",
      "classification",
      "reasoning",
      "summarisation",
    ]);
  });
});

describe("llm.status", () => {
  test("returns per-task decisions with modelName, isAvailable, and reason", async () => {
    const getRouterStatus = mock(async () => ({
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
      agent_step: {
        providerId: "ollama",
        modelName: "llama3.2",
        isAvailable: true,
        reason: "prefer-local",
      },
    }));
    const registry = { getRouterStatus } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    expect(r.kind).toBe("hit");
    const val = (r as { kind: "hit"; value: { decisions: Record<string, unknown> } }).value;
    expect(val.decisions["classification"]).toMatchObject({
      modelName: "llama3.2",
      isAvailable: true,
      reason: "prefer-local",
    });
    expect(getRouterStatus).toHaveBeenCalledTimes(1);
  });
});

describe("llm.setDefault", () => {
  test("persists default per task type and echoes back", async () => {
    const setDefault = mock(async () => {});
    const registry = { setDefault } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc(
      "llm.setDefault",
      { taskType: "classification", provider: "ollama", modelName: "gemma:2b" },
      { registry, notify: () => {} },
    );
    expect(r.kind).toBe("hit");
    expect((r as { kind: "hit"; value: { taskType: string } }).value.taskType).toBe(
      "classification",
    );
    expect(setDefault).toHaveBeenCalledWith("classification", "ollama", "gemma:2b");
  });

  test("rejects invalid taskType", async () => {
    const registry = { setDefault: mock(async () => {}) } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "bogus", provider: "ollama", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });
});
