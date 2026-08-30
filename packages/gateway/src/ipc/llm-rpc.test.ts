import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNimbusTomlLlmSection } from "../config/nimbus-toml.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import { RouteAvailabilityProbe } from "../llm/route-availability.ts";
import { LlmRouter } from "../llm/router.ts";
import type { LlmModelInfo, ModelRoute } from "../llm/types.ts";
import type { LlmRouteStatus, LlmRpcContext } from "./llm-rpc.ts";
import { dispatchLlmRpc, LlmRpcError } from "./llm-rpc.ts";

// TEST-DATA SAFETY: every `tomlPath` below lives under a fresh `os.tmpdir()` directory,
// never the real per-machine config dir — `llm.use` writes files, and this suite must never
// touch a real `nimbus.toml`.
function makeTempTomlPath(initialContent = ""): { tomlPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-llm-rpc-test-"));
  const tomlPath = join(dir, "nimbus.toml");
  writeFileSync(tomlPath, initialContent, "utf8");
  return { tomlPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeProviderForRouter(id: string, reportedModels: string[]) {
  return {
    providerId: id,
    isLocal: true,
    isAvailable: async () => true,
    listModels: async () => reportedModels.map((modelName) => ({ provider: id, modelName })),
    generate: async () => {
      throw new Error("generate() not used by this test");
    },
  };
}

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
    // Third argument is the lifecycle discriminator: `{}` when the caller named no routeId.
    expect(loadModel).toHaveBeenCalledWith("ollama", "gemma:2b", {});
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
    expect(unloadModel).toHaveBeenCalledWith("ollama", "gemma:2b", {});
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
    expect(loadModel).toHaveBeenCalledWith("remote", "x", {});
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
/**
 * A fake registry that mirrors the real one's OWNERSHIP of the availability probe: one
 * `RouteAvailabilityProbe` per registry, reached only through `checkRoute`. `llm.status` used to
 * construct a probe of its own per request — a cache no other caller shared, so it could report a
 * route available that the router had already routed past. The fake still exercises the probe's
 * REAL reachable/model-listing logic; only its owner changed.
 */
function makeFakeRouteRegistry(routes: unknown[]): LlmRegistry {
  const probe = new RouteAvailabilityProbe();
  return {
    llmRouter: { routes: () => routes },
    checkRoute: (route: ModelRoute) => probe.check(route),
  } as unknown as LlmRegistry;
}

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
    const registry = makeFakeRouteRegistry(routes);
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
    const registry = makeFakeRouteRegistry(routes);
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    const val = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    expect(val.routes[0]).toMatchObject({ available: false, reason: "provider_unreachable" });
  });

  test("returns an empty route list when no routes are registered", async () => {
    const registry = makeFakeRouteRegistry([]);
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
    const registry = makeFakeRouteRegistry(routes);
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
    const registry = makeFakeRouteRegistry(routes);
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
  // #1383: this endpoint was WRITE-ONLY. It persisted to `llm_task_defaults` (V20) and nothing
  // read that table — the desktop control appeared to work and changed nothing about routing.
  // It now writes the SAME store `nimbus llm use` writes, `[llm.tasks]`, which is what the
  // router actually honours. The wire shape is unchanged, because the renderer calls it.
  test("writes the pin into [llm.tasks] and updates the live router", async () => {
    const { tomlPath, cleanup } = makeTempTomlPath();
    try {
      const router = new LlmRouter({
        preferLocal: true,
        localModel: "llama3.2:latest",
        minReasoningParams: 0,
        enforceAirGap: false,
      });
      router.registerRoute(
        makeFakeProviderForRouter("ollama", ["llama3.2:latest"]),
        "llama3.2:latest",
      );
      const registry = { llmRouter: router } as unknown as LlmRegistry;
      const ctx: LlmRpcContext = { registry, notify: () => {}, tomlPath };

      const r = await dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "classification", provider: "ollama", modelName: "llama3.2:latest" },
        ctx,
      );
      expect(r.kind).toBe("hit");
      expect((r as { kind: "hit"; value: { taskType: string } }).value.taskType).toBe(
        "classification",
      );

      // Round-tripped through the SAME parser boot uses — "a file was touched" is not the claim.
      const reparsed = parseNimbusTomlLlmSection(readFileSync(tomlPath, "utf8"));
      expect(reparsed.taskPins?.get("classification")).toBe("ollama/llama3.2:latest");
      // AND live, without a restart — the half that was missing entirely before.
      expect((await router.selectRoute("classification"))?.routeId).toBe("ollama/llama3.2:latest");
    } finally {
      cleanup();
    }
  });

  // Fail-CLOSED, matching `llm.use`. Persisting a pin to a route that does not exist is the
  // orphaned-config shape #1383 is itself an instance of.
  test("REFUSES a provider/model that is not a registered route, and writes nothing", async () => {
    const { tomlPath, cleanup } = makeTempTomlPath("[llm]\nprefer_local = true\n");
    try {
      const before = readFileSync(tomlPath, "utf8");
      const router = new LlmRouter({
        preferLocal: true,
        localModel: "llama3.2:latest",
        minReasoningParams: 0,
        enforceAirGap: false,
      });
      router.registerRoute(makeFakeProviderForRouter("ollama", ["big"]), "big");
      const registry = { llmRouter: router } as unknown as LlmRegistry;
      const ctx: LlmRpcContext = { registry, notify: () => {}, tomlPath };

      await expect(
        dispatchLlmRpc(
          "llm.setDefault",
          { taskType: "reasoning", provider: "ollama", modelName: "ghost" },
          ctx,
        ),
      ).rejects.toThrow(/not a registered route/);
      expect(readFileSync(tomlPath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  // The question #1383 was blocked on: what should the UI do with no writable config path?
  // Answered the same way `llm.use` already answers it — refuse, loudly. A silent success that
  // persists nothing is precisely the bug being fixed.
  test("refuses when there is no configured toml path", async () => {
    const router = new LlmRouter({
      preferLocal: true,
      localModel: "llama3.2:latest",
      minReasoningParams: 0,
      enforceAirGap: false,
    });
    router.registerRoute(
      makeFakeProviderForRouter("ollama", ["llama3.2:latest"]),
      "llama3.2:latest",
    );
    const registry = { llmRouter: router } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "classification", provider: "ollama", modelName: "llama3.2:latest" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow(/configDir/);
  });

  // `makeRouteId` throws a RAW Error on a slash in the provider, and the dispatcher does not
  // convert handler errors into `LlmRpcError` — so this input escaped as an internal-error shape
  // instead of invalid-params. Verified before fixing: the thrown value had no `code` at all.
  test("rejects a provider containing a slash with invalid-params, not a raw Error", async () => {
    const router = new LlmRouter({
      preferLocal: true,
      localModel: "llama3.2:latest",
      minReasoningParams: 0,
      enforceAirGap: false,
    });
    const registry = { llmRouter: router } as unknown as LlmRegistry;
    const err = await dispatchLlmRpc(
      "llm.setDefault",
      { taskType: "classification", provider: "foo/bar", modelName: "m" },
      { registry, notify: () => {}, tomlPath: "/nonexistent/nimbus.toml" },
    ).then(
      () => undefined,
      (e: unknown) => e as { rpcCode?: number; name?: string },
    );
    // Asserted on `rpcCode`, the field `LlmRpcError` actually carries — not `code`, which is
    // undefined on BOTH a raw Error and an LlmRpcError and so would pass for the wrong reason.
    expect(err?.name).toBe("LlmRpcError");
    expect(err?.rpcCode).toBe(-32602);
  });

  test("rejects invalid taskType", async () => {
    const registry = {
      llmRouter: new LlmRouter({
        preferLocal: true,
        localModel: "x",
        minReasoningParams: 0,
        enforceAirGap: false,
      }),
    } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "bogus", provider: "ollama", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });

  test("rejects empty provider", async () => {
    const registry = {
      llmRouter: new LlmRouter({
        preferLocal: true,
        localModel: "x",
        minReasoningParams: 0,
        enforceAirGap: false,
      }),
    } as unknown as LlmRegistry;
    await expect(
      dispatchLlmRpc(
        "llm.setDefault",
        { taskType: "classification", provider: "", modelName: "x" },
        { registry, notify: () => {} },
      ),
    ).rejects.toThrow();
  });
});

describe("missing params map to -32602, never a raw TypeError (Fix D)", () => {
  // JSON-RPC allows `params` to be omitted entirely. The cast this replaces left `p`
  // `undefined` and the next line read `p.modelName`, throwing a raw `TypeError` — and only
  // `LlmRpcError` is mapped to `-32602 Invalid params`, so "you forgot the arguments" surfaced
  // to the client as an internal error.
  const registry = {
    pullModel: mock(async () => {}),
    loadModel: mock(async () => {}),
    unloadModel: mock(async () => {}),
    setDefault: mock(async () => {}),
  } as unknown as LlmRegistry;

  for (const method of [
    "llm.pullModel",
    "llm.loadModel",
    "llm.unloadModel",
    "llm.setDefault",
    "llm.cancelPull",
  ]) {
    for (const [label, params] of [
      ["undefined", undefined],
      ["null", null],
      ["a string", "modelName"],
      ["an array", ["gemma:2b"]],
    ] as Array<[string, unknown]>) {
      test(`${method} with ${label} params rejects as LlmRpcError(-32602)`, async () => {
        let thrown: unknown;
        try {
          await dispatchLlmRpc(method, params, { registry, notify: () => {} });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(LlmRpcError);
        expect((thrown as LlmRpcError).rpcCode).toBe(-32602);
        // Specifically NOT a bare TypeError — the shape that produced the wrong RPC code.
        expect(thrown).not.toBeInstanceOf(TypeError);
      });
    }
  }

  test("a well-formed request still succeeds — the guard rejects shape, not content", async () => {
    const pullModel = mock(async () => {});
    const r = await dispatchLlmRpc(
      "llm.pullModel",
      { provider: "ollama", modelName: "gemma:2b" },
      { registry: { pullModel } as unknown as LlmRegistry, notify: () => {} },
    );
    expect(r.kind).toBe("hit");
    expect(pullModel).toHaveBeenCalledTimes(1);
  });

  test("a non-string routeId is rejected rather than silently dropped", async () => {
    const pullModel = mock(async () => {});
    await expect(
      dispatchLlmRpc(
        "llm.pullModel",
        { provider: "ollama", modelName: "gemma:2b", routeId: 7 },
        { registry: { pullModel } as unknown as LlmRegistry, notify: () => {} },
      ),
    ).rejects.toThrow("routeId must be a non-empty string");
    expect(pullModel).not.toHaveBeenCalled();
  });

  test("routeId is forwarded to the registry when supplied", async () => {
    const pullModel = mock(async () => {});
    await dispatchLlmRpc(
      "llm.pullModel",
      { provider: "ollama", modelName: "gemma:2b", routeId: "ollama/qwen3:8b" },
      { registry: { pullModel } as unknown as LlmRegistry, notify: () => {} },
    );
    expect(pullModel).toHaveBeenCalledWith(
      "ollama",
      "gemma:2b",
      expect.objectContaining({ routeId: "ollama/qwen3:8b" }),
    );
  });
});

describe("llm.status reads the registry-owned probe (Fix E)", () => {
  test("availability comes from registry.checkRoute, not a probe llm.status builds", async () => {
    // The provider itself is UNREACHABLE. A probe constructed inside `getRouteStatuses` would
    // answer `provider_unreachable` from its own private cache; the registry-owned probe is
    // the authority route selection also consults, and here it says `ok`. Only the delegating
    // implementation can produce this result — which is the whole point: the two snapshots
    // must not be able to disagree.
    const provider = makeFakeLlmProvider({
      providerId: "ollama",
      isLocal: true,
      reachable: false,
      reportedModels: [],
    });
    const routes = [{ routeId: "ollama/qwen3:8b", provider, modelName: "qwen3:8b", meta: {} }];
    const checkRoute = mock(async () => ({ available: true, reason: "ok" as const }));
    const registry = {
      llmRouter: { routes: () => routes },
      checkRoute,
    } as unknown as LlmRegistry;
    const r = await dispatchLlmRpc("llm.status", null, { registry, notify: () => {} });
    const val = (r as { kind: "hit"; value: { routes: LlmRouteStatus[] } }).value;
    expect(checkRoute).toHaveBeenCalledTimes(1);
    expect(val.routes[0]).toMatchObject({ available: true, reason: "ok" });
  });
});

describe("llm.use", () => {
  test("writes the pin into [llm.tasks] and updates the live router", async () => {
    const { tomlPath, cleanup } = makeTempTomlPath();
    try {
      const router = new LlmRouter({
        preferLocal: true,
        localModel: "llama3.2:latest",
        minReasoningParams: 0,
        enforceAirGap: false,
      });
      router.registerRoute(
        makeFakeProviderForRouter("ollama", ["llama3.2:latest"]),
        "llama3.2:latest",
      );
      const registry = { llmRouter: router } as unknown as LlmRegistry;
      const ctx: LlmRpcContext = { registry, notify: () => {}, tomlPath };

      const result = await dispatchLlmRpc(
        "llm.use",
        { task: "classification", routeId: "ollama/llama3.2:latest" },
        ctx,
      );
      expect(result.kind).toBe("hit");

      // Persisted: survives a restart, because boot re-reads exactly this table.
      const written = readFileSync(tomlPath, "utf8");
      expect(written).toContain('classification = "ollama/llama3.2:latest"');
      // Round trip, not just "a file was touched": re-parse with the SAME parser boot uses.
      const reparsed = parseNimbusTomlLlmSection(written);
      expect(reparsed.taskPins?.get("classification")).toBe("ollama/llama3.2:latest");

      // AND live: the running router honours it without a restart.
      expect((await router.selectRoute("classification"))?.routeId).toBe("ollama/llama3.2:latest");
    } finally {
      cleanup();
    }
  });

  test("REFUSES a route id that is not registered, and writes nothing", async () => {
    const { tomlPath, cleanup } = makeTempTomlPath("[llm]\nprefer_local = true\n");
    try {
      const before = readFileSync(tomlPath, "utf8");
      const router = new LlmRouter({
        preferLocal: true,
        localModel: "llama3.2:latest",
        minReasoningParams: 0,
        enforceAirGap: false,
      });
      router.registerRoute(makeFakeProviderForRouter("ollama", ["big"]), "big");
      const registry = { llmRouter: router } as unknown as LlmRegistry;
      const ctx: LlmRpcContext = { registry, notify: () => {}, tomlPath };

      await expect(
        dispatchLlmRpc("llm.use", { task: "reasoning", routeId: "ollama/ghost" }, ctx),
      ).rejects.toThrow(/not a registered route/);
      expect(readFileSync(tomlPath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("REFUSES an unknown task type", async () => {
    const { tomlPath, cleanup } = makeTempTomlPath();
    try {
      const router = new LlmRouter({
        preferLocal: true,
        localModel: "llama3.2:latest",
        minReasoningParams: 0,
        enforceAirGap: false,
      });
      router.registerRoute(makeFakeProviderForRouter("ollama", ["x"]), "x");
      const registry = { llmRouter: router } as unknown as LlmRegistry;
      const ctx: LlmRpcContext = { registry, notify: () => {}, tomlPath };

      await expect(
        dispatchLlmRpc("llm.use", { task: "teleportation", routeId: "ollama/x" }, ctx),
      ).rejects.toThrow(/classification|reasoning|summarisation|agent_step/);
      // Nothing was written — the task check runs before the route/persist steps.
      expect(readFileSync(tomlPath, "utf8")).toBe("");
    } finally {
      cleanup();
    }
  });

  test("refuses when the gateway has no resolved configDir (tomlPath absent)", async () => {
    const router = new LlmRouter({
      preferLocal: true,
      localModel: "llama3.2:latest",
      minReasoningParams: 0,
      enforceAirGap: false,
    });
    router.registerRoute(makeFakeProviderForRouter("ollama", ["x"]), "x");
    const registry = { llmRouter: router } as unknown as LlmRegistry;
    const ctx: LlmRpcContext = { registry, notify: () => {} }; // no tomlPath

    await expect(
      dispatchLlmRpc("llm.use", { task: "classification", routeId: "ollama/x" }, ctx),
    ).rejects.toThrow(LlmRpcError);
  });
});
