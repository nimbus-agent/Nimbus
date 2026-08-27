import { describe, expect, mock, test } from "bun:test";
import type { LlmRegistry } from "../llm/registry.ts";
import type { LlmModelInfo } from "../llm/types.ts";
import type { LlmRouteStatus, LlmRpcContext } from "./llm-rpc.ts";
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

  test("rejects empty provider with -32602", async () => {
    const registry = { pullModel: mock(async () => {}) } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.pullModel",
        { provider: "", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });

  // Deferred finding (Task 6/10): validity of a provider string is no longer decided by an
  // RPC-level closed set — `requireModelParams` accepts any non-empty string, so an
  // unregistered provider reaches `registry.pullModel` (the widened `ProviderId` signature),
  // and its rejection surfaces the same way any other pull failure does: via `llm.pullFailed`,
  // not an RPC-level throw (pullModel returns { pullId } immediately, fire-and-forget).
  test("an unregistered provider is rejected by the registry, not by RPC-level validation", async () => {
    const registryError = new Error("Provider not registered: remote");
    const pullModel = mock(async () => {
      throw registryError;
    });
    const registry = { pullModel } as unknown as LlmRegistry;
    const notify = mock((_m: string, _p: unknown) => {});
    const result = await dispatchLlmRpc(
      "llm.pullModel",
      { provider: "remote", modelName: "x" },
      { registry, notify },
    );
    expect(result.kind).toBe("hit");
    expect(pullModel).toHaveBeenCalledWith("remote", "x", expect.anything());
    // Let the fire-and-forget .then()/.catch() chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledWith(
      "llm.pullFailed",
      expect.objectContaining({ provider: "remote", error: "Provider not registered: remote" }),
    );
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

  // Deferred finding (Task 6/10): `loadModel`/`unloadModel` take `ProviderId` (any string) —
  // previously `requireLocalProvider` narrowed to a closed two-member union and rejected
  // "remote" before the registry was ever called, making the widened signature unreachable
  // from IPC. Now the call reaches the registry, and the registry decides validity.
  test("loadModel rejects an unregistered provider via the registry, not RPC-level validation", async () => {
    const loadModel = mock(async () => {
      throw new Error("Provider not registered: remote");
    });
    const registry = { loadModel } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.loadModel",
        { provider: "remote", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow("Provider not registered: remote");
    expect(loadModel).toHaveBeenCalledWith("remote", "x");
  });

  test("loadModel rejects empty provider with -32602 before reaching the registry", async () => {
    const loadModel = mock(async () => {});
    const registry = { loadModel } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.loadModel",
        { provider: "", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
    expect(loadModel).not.toHaveBeenCalled();
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

// A minimal `LlmProvider`-shaped fake — enough for `RouteAvailabilityProbe.check()` to exercise
// its real reachable/model-listing logic against, rather than mocking the probe's own verdict.
function makeFakeLlmProvider(opts: {
  providerId: string;
  isLocal: boolean;
  reachable: boolean;
  reportedModels: string[];
}) {
  return {
    providerId: opts.providerId,
    isLocal: opts.isLocal,
    isAvailable: async () => opts.reachable,
    listModels: async () =>
      opts.reportedModels.map((modelName) => ({ provider: opts.providerId, modelName })),
    generate: async () => {
      throw new Error("generate() not used by this test");
    },
  };
}

describe("llm.status", () => {
  test("lists every route (routeId, providerId, modelName, isLocal, available, reason, contextWindow)", async () => {
    const provider = makeFakeLlmProvider({
      providerId: "ollama",
      isLocal: true,
      reachable: true,
      reportedModels: ["qwen3:8b"],
    });
    // Two routes sharing one provider instance/daemon: this is the headline case (deferred
    // finding, Task 3/10) — a same-provider, different-model fallback must be expressible.
    // Listing every route separately (rather than the old one-decision-per-task-type shape)
    // makes "ollama/qwen3:8b is up, ollama/gemma3:12b is down" visible without any fallback
    // field at all.
    const routes = [
      {
        routeId: "ollama/qwen3:8b",
        provider,
        modelName: "qwen3:8b",
        meta: { contextWindow: 8192 },
      },
      {
        routeId: "ollama/gemma3:12b",
        provider,
        modelName: "gemma3:12b",
        meta: {},
      },
    ];
    const registry = { llmRouter: { routes: () => routes } } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    expect(r.kind).toBe("hit");
    const val = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    expect(val.routes).toHaveLength(2);

    const qwen = val.routes.find((x) => x.routeId === "ollama/qwen3:8b");
    expect(qwen).toMatchObject({
      routeId: "ollama/qwen3:8b",
      providerId: "ollama",
      modelName: "qwen3:8b",
      isLocal: true,
      available: true,
      reason: "ok",
      contextWindow: 8192,
    });

    // The absent-model route: same provider/daemon (so provider_unreachable cannot explain
    // it), but its own modelName was never pulled — must report `model_absent`, distinct from
    // `provider_unreachable`, and its contextWindow must stay undefined (never fabricated).
    const gemma = val.routes.find((x) => x.routeId === "ollama/gemma3:12b");
    expect(gemma).toMatchObject({
      routeId: "ollama/gemma3:12b",
      providerId: "ollama",
      modelName: "gemma3:12b",
      isLocal: true,
      available: false,
      reason: "model_absent",
    });
    expect(gemma?.contextWindow).toBeUndefined();
  });

  test("reports provider_unreachable (not model_absent) when the daemon itself is down", async () => {
    const provider = makeFakeLlmProvider({
      providerId: "llamacpp",
      isLocal: true,
      reachable: false,
      reportedModels: [],
    });
    const routes = [
      { routeId: "llamacpp/model.gguf", provider, modelName: "model.gguf", meta: {} },
    ];
    const registry = { llmRouter: { routes: () => routes } } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    const val = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    expect(val.routes[0]).toMatchObject({ available: false, reason: "provider_unreachable" });
  });

  test("returns an empty route list when no routes are registered", async () => {
    const registry = { llmRouter: { routes: () => [] } } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    expect(r.kind).toBe("hit");
    expect((r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value.routes).toEqual([]);
  });

  // `packages/cli` cannot import gateway types — the dependency rule is IPC-only, no source
  // imports (see CLAUDE.md "Dependency rules") — so `packages/cli/src/commands/llm.ts`'s
  // `RouteStatus` is a HAND-MAINTAINED copy of this shape, and its own tests mock the IPC
  // client wholesale rather than talking to a real dispatcher. Nothing on the CLI side would
  // notice a gateway-side reshape. This already happened once in this branch — a caller went
  // on reading `res.decisions.classification` after `llm.status` became a route list, and the
  // whole suite stayed green (see Task 10). Pinning the EXACT key set here (not `toMatchObject`,
  // which tolerates extra fields) is the gateway half of the fix; the CLI half stays a
  // documented bound — see docs/CHANGELOG.md's 2026-08-27 entry.
  test("pins the exact route object key set (available route: contextWindow present)", async () => {
    const provider = makeFakeLlmProvider({
      providerId: "ollama",
      isLocal: true,
      reachable: true,
      reportedModels: ["qwen3:8b"],
    });
    const routes = [
      {
        routeId: "ollama/qwen3:8b",
        provider,
        modelName: "qwen3:8b",
        meta: { contextWindow: 8192 },
      },
    ];
    const registry = { llmRouter: { routes: () => routes } } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    expect(r.kind).toBe("hit");
    const value = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    // Top level: exactly `{ routes }` — no sibling key the CLI's `LlmStatusResponse` doesn't
    // also declare.
    expect(Object.keys(value).sort()).toEqual(["routes"]);
    const route = value.routes[0];
    expect(route).toBeDefined();
    expect(Object.keys(route as object).sort()).toEqual([
      "available",
      "contextWindow",
      "isLocal",
      "modelName",
      "providerId",
      "reason",
      "routeId",
    ]);
  });

  test("pins the exact route object key set (contextWindow ABSENT — never a fabricated key)", async () => {
    const provider = makeFakeLlmProvider({
      providerId: "ollama",
      isLocal: true,
      reachable: true,
      reportedModels: ["qwen3:8b"],
    });
    // No `meta.contextWindow` at all — the route object must OMIT the key entirely (matching
    // the CLI's "render — for a missing contextWindow" contract), not carry it as `undefined`.
    const routes = [{ routeId: "ollama/qwen3:8b", provider, modelName: "qwen3:8b", meta: {} }];
    const registry = { llmRouter: { routes: () => routes } } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    const value = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    const route = value.routes[0];
    expect(route).toBeDefined();
    expect(Object.keys(route as object).sort()).toEqual([
      "available",
      "isLocal",
      "modelName",
      "providerId",
      "reason",
      "routeId",
    ]);
    expect("contextWindow" in (route as object)).toBe(false);
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

  test("rejects empty provider", async () => {
    const registry = { setDefault: mock(async () => {}) } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "classification", provider: "", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });

  // Deleted symbol (Task 10): `VALID_LLM_PROVIDERS` used to reject any provider outside
  // {"ollama", "llamacpp", "remote"}. Validity is now the registry's answer alone.
  test("accepts a provider string outside the old closed set", async () => {
    const setDefault = mock(async () => {});
    const registry = { setDefault } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc(
      "llm.setDefault",
      { taskType: "reasoning", provider: "gemini", modelName: "gemini-pro" },
      { registry, notify: () => {} },
    );
    expect(r.kind).toBe("hit");
    expect(setDefault).toHaveBeenCalledWith("reasoning", "gemini", "gemini-pro");
  });
});
