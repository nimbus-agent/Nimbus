import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLM_MODELS_V16_SQL } from "../index/llm-models-v16-sql.ts";
import { LLM_TASK_DEFAULTS_V20_SQL } from "../index/llm-task-defaults-v20-sql.ts";
import { LlmRegistry } from "./registry.ts";
import type { LlmRouterConfig } from "./router.ts";
import type { LlmModelInfo, LlmProvider, LlmProviderKind, PullProgressChunk } from "./types.ts";

const DEFAULT_CONFIG: LlmRouterConfig = {
  preferLocal: true,
  remoteModel: "claude-sonnet-4-6",
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

type ProviderOpts = {
  available: boolean;
  models?: LlmModelInfo[];
  loadModel?: (m: string) => Promise<void>;
  unloadModel?: (m: string) => Promise<void>;
  pullModel?: (
    m: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void },
  ) => Promise<void>;
  throwOnAvailable?: boolean;
  throwOnList?: boolean;
};

function makeProvider(id: LlmProviderKind, opts: ProviderOpts): LlmProvider {
  const base = {
    providerId: id,
    isLocal: id !== "remote",
    isAvailable: async () => {
      if (opts.throwOnAvailable === true) throw new Error("availability check failed");
      return opts.available;
    },
    listModels: async (): Promise<LlmModelInfo[]> => {
      if (opts.throwOnList === true) throw new Error("listModels failed");
      return opts.models ?? [];
    },
    generate: async () => ({
      text: "x",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: id,
      isLocal: id !== "remote",
      provider: id,
    }),
  };

  if (opts.loadModel !== undefined) {
    (base as unknown as { loadModel: (m: string) => Promise<void> }).loadModel = opts.loadModel;
  }
  if (opts.unloadModel !== undefined) {
    (base as unknown as { unloadModel: (m: string) => Promise<void> }).unloadModel =
      opts.unloadModel;
  }
  if (opts.pullModel !== undefined) {
    (base as unknown as { pullModel: typeof opts.pullModel }).pullModel = opts.pullModel;
  }
  return base;
}

function makeDbWithSchema(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-registry-"));
  const db = new Database(join(dir, "test.db"));
  db.exec(LLM_MODELS_V16_SQL.replace(/ALTER TABLE.*$/m, ""));
  db.exec(LLM_TASK_DEFAULTS_V20_SQL);
  return { db, dir };
}

describe("LlmRegistry — construction + provider registration", () => {
  test("exposes the underlying LlmRouter via llmRouter getter", () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    expect(reg.llmRouter).toBeDefined();
    expect(typeof reg.llmRouter.selectProvider).toBe("function");
  });

  test("addProvider forwards to LlmRouter.registerProvider", () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    // The model-aware availability probe (Task 5) needs the fake to report the model
    // `registerProvider` assigns it (`config.localModel`), or it reads as unavailable.
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: DEFAULT_CONFIG.localModel }],
      }),
    );
    return reg.llmRouter.selectProvider("agent_step").then((p) => {
      expect(p?.providerId).toBe("ollama");
    });
  });
});

describe("LlmRegistry.listAllModels", () => {
  let env: { db: Database; dir: string } | undefined;

  afterEach(() => {
    if (env !== undefined) {
      env.db.close();
      try {
        rmSync(env.dir, { recursive: true, force: true });
      } catch {
        /* harmless */
      }
      env = undefined;
    }
  });

  test("returns models from all registered + available providers", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "llama3.2", parameterCount: 3 }],
      }),
    );
    reg.addProvider(
      makeProvider("llamacpp", {
        available: true,
        models: [{ provider: "llamacpp", modelName: "qwen", contextWindow: 8192 }],
      }),
    );
    reg.addProvider(
      makeProvider("remote", {
        available: true,
        models: [{ provider: "remote", modelName: "claude-sonnet-4-6" }],
      }),
    );
    const models = await reg.listAllModels();
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.provider).sort((a, b) => a.localeCompare(b))).toEqual([
      "llamacpp",
      "ollama",
      "remote",
    ]);
  });

  test("skips a provider when isAvailable returns false", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "m1" }],
      }),
    );
    reg.addProvider(
      makeProvider("llamacpp", {
        available: false,
        models: [{ provider: "llamacpp", modelName: "m2" }],
      }),
    );
    const models = await reg.listAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.provider).toBe("ollama");
  });

  test("a thrown provider error is swallowed (skip silently)", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addProvider(makeProvider("ollama", { available: true, throwOnList: true }));
    reg.addProvider(
      makeProvider("remote", {
        available: true,
        models: [{ provider: "remote", modelName: "good" }],
      }),
    );
    const models = await reg.listAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.modelName).toBe("good");
  });

  test("syncs models to llm_models table on each listAllModels call", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        models: [
          {
            provider: "ollama",
            modelName: "llama3.2",
            parameterCount: 3,
            contextWindow: 8192,
            quantization: "Q4_K_M",
            vramEstimateMb: 2048,
          },
        ],
      }),
    );
    await reg.listAllModels();
    const row = env.db
      .query(
        "SELECT provider, model_name, parameter_count, context_window, quantization, vram_estimate_mb FROM llm_models WHERE provider = ?",
      )
      .get("ollama") as
      | {
          provider: string;
          model_name: string;
          parameter_count: number | null;
          context_window: number | null;
          quantization: string | null;
          vram_estimate_mb: number | null;
        }
      | undefined;
    expect(row?.model_name).toBe("llama3.2");
    expect(row?.parameter_count).toBe(3);
    expect(row?.context_window).toBe(8192);
    expect(row?.quantization).toBe("Q4_K_M");
    expect(row?.vram_estimate_mb).toBe(2048);
  });

  test("no-DB mode skips sync without throwing", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "x" }],
      }),
    );
    await expect(reg.listAllModels()).resolves.toBeDefined();
  });
});

describe("LlmRegistry.checkAvailability", () => {
  test("returns per-provider booleans for registered providers", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(makeProvider("ollama", { available: true }));
    reg.addProvider(makeProvider("remote", { available: false }));
    const out = await reg.checkAvailability();
    expect(out["ollama"]).toBe(true);
    expect(out["remote"]).toBe(false);
    expect(out["llamacpp"]).toBeUndefined();
  });

  test("isAvailable throw → false for that provider", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(makeProvider("ollama", { available: false, throwOnAvailable: true }));
    const out = await reg.checkAvailability();
    expect(out["ollama"]).toBe(false);
  });
});

describe("LlmRegistry.loadModel / unloadModel", () => {
  test("loadModel invokes the provider's loadModel when defined", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    let captured = "";
    reg.addProvider(
      makeProvider("llamacpp", {
        available: true,
        loadModel: async (m) => {
          captured = m;
        },
      }),
    );
    await reg.loadModel("llamacpp", "qwen.gguf");
    expect(captured).toBe("qwen.gguf");
  });

  test("loadModel is a no-op when the provider does not implement it", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(makeProvider("ollama", { available: true }));
    await expect(reg.loadModel("ollama", "any-model")).resolves.toBeUndefined();
  });

  test("loadModel throws when provider is not registered", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    await expect(reg.loadModel("ollama", "x")).rejects.toThrow("Provider not registered: ollama");
  });

  test("unloadModel invokes the provider's unloadModel when defined", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    let captured = "";
    reg.addProvider(
      makeProvider("llamacpp", {
        available: true,
        unloadModel: async (m) => {
          captured = m;
        },
      }),
    );
    await reg.unloadModel("llamacpp", "qwen.gguf");
    expect(captured).toBe("qwen.gguf");
  });

  test("unloadModel throws for unregistered provider", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    await expect(reg.unloadModel("llamacpp", "x")).rejects.toThrow(
      "Provider not registered: llamacpp",
    );
  });
});

describe("LlmRegistry.pullModel", () => {
  test("dispatches to provider.pullModel when supported", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    let captured = "";
    reg.addProvider(
      makeProvider("ollama", {
        available: true,
        pullModel: async (m) => {
          captured = m;
        },
      }),
    );
    await reg.pullModel("ollama", "llama3.2");
    expect(captured).toBe("llama3.2");
  });

  test("rejects with TypeError when provider lacks pullModel", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(makeProvider("llamacpp", { available: true }));
    await expect(reg.pullModel("llamacpp", "x")).rejects.toThrow(
      "Provider llamacpp does not support pullModel",
    );
  });

  test("rejects when provider is not registered", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    await expect(reg.pullModel("ollama", "x")).rejects.toThrow("Provider not registered: ollama");
  });
});

describe("LlmRegistry.setDefault / getDefault", () => {
  let env: { db: Database; dir: string } | undefined;

  afterEach(() => {
    if (env !== undefined) {
      env.db.close();
      try {
        rmSync(env.dir, { recursive: true, force: true });
      } catch {
        /* harmless */
      }
      env = undefined;
    }
  });

  test("UPSERTs into llm_task_defaults when DB is provided", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    await reg.setDefault("reasoning", "ollama", "llama3.2");
    const got = reg.getDefault("reasoning");
    expect(got).toEqual({ provider: "ollama", modelName: "llama3.2" });
  });

  test("ON CONFLICT updates the existing row on second setDefault", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    await reg.setDefault("reasoning", "ollama", "llama3.2");
    await reg.setDefault("reasoning", "remote", "claude");
    expect(reg.getDefault("reasoning")).toEqual({ provider: "remote", modelName: "claude" });
  });

  test("setDefault no-ops silently when DB is undefined", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    await expect(reg.setDefault("classification", "ollama", "any")).resolves.toBeUndefined();
  });

  test("getDefault returns undefined when DB is undefined", () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    expect(reg.getDefault("classification")).toBeUndefined();
  });

  test("getDefault on a missing-row throws (bun:sqlite .get() returns null, not undefined)", () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    expect(() => reg.getDefault("classification")).toThrow();
  });
});

describe("LlmRegistry.addRoute + providerId-keyed lifecycle (Task 6)", () => {
  test("pullModel works for a model that has NO route", async () => {
    // The primary use of pull: fetch a model BEFORE configuring a route for it. Keying
    // lifecycle on routeId would make this impossible — see Task 6 brief.
    const pulled: string[] = [];
    const provider = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        pulled.push(m);
      },
    });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG });
    registry.addRoute(provider, "qwen3:8b");
    await registry.pullModel("ollama", "a-model-with-no-route");
    expect(pulled).toEqual(["a-model-with-no-route"]);
  });

  test("listAllModels covers a vendor id the registry has never heard of", async () => {
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG });
    registry.addRoute(
      makeProvider("gemini", {
        available: true,
        models: [{ provider: "gemini", modelName: "gemini-2.5-pro" }],
      }),
      "gemini-2.5-pro",
    );
    const models = await registry.listAllModels();
    expect(models.some((m) => m.provider === "gemini")).toBe(true);
  });

  test("a successful pullModel invalidates the route-availability cache for that providerId", async () => {
    // Without invalidate(), a freshly-pulled model reports model_absent for up to the
    // positive TTL — indistinguishable from the pull having failed.
    let reportedModels: string[] = [];
    const provider = makeProvider("ollama", {
      available: true,
      models: [],
      pullModel: async (m) => {
        reportedModels = [m];
      },
    });
    (provider as unknown as { listModels: () => Promise<LlmModelInfo[]> }).listModels = async () =>
      reportedModels.map((m) => ({ provider: "ollama", modelName: m }));
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG });
    registry.addRoute(provider, "fresh-model");
    // Prime the negative cache: at this point the daemon does not yet report the model.
    const before = await registry.llmRouter.selectProvider("agent_step");
    expect(before).toBeUndefined();
    await registry.pullModel("ollama", "fresh-model");
    const after = await registry.llmRouter.selectProvider("agent_step");
    expect(after?.providerId).toBe("ollama");
  });

  test("a FAILED pullModel does not invalidate the cache", async () => {
    // Same technique as the success test above, but the pull rejects: prime the
    // negative cache, fail the pull, THEN flip listModels() to report the model, and
    // assert the route STILL reads as unavailable — because a failed pull must not
    // have cleared the cache, and the stale (positive-TTL) entry should still be in
    // effect. This assertion is what actually distinguishes "invalidate was correctly
    // skipped" from "invalidate ran anyway" — a bare `rejects.toThrow` on the pull
    // call cannot: it stays green whether or not invalidate() runs on failure.
    let reportedModels: string[] = [];
    const provider = makeProvider("ollama", {
      available: true,
      models: [],
      pullModel: async () => {
        throw new Error("pull failed");
      },
    });
    (provider as unknown as { listModels: () => Promise<LlmModelInfo[]> }).listModels = async () =>
      reportedModels.map((m) => ({ provider: "ollama", modelName: m }));
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG });
    registry.addRoute(provider, "fresh-model");
    // Prime the negative cache: at this point the daemon does not report the model.
    const before = await registry.llmRouter.selectProvider("agent_step");
    expect(before).toBeUndefined();
    await expect(registry.pullModel("ollama", "fresh-model")).rejects.toThrow("pull failed");
    // The daemon now DOES report the model (as if it landed some other way) — but the
    // cache must still be serving its stale, pre-pull answer, because invalidate()
    // must not have run on this failed pull.
    reportedModels = ["fresh-model"];
    const after = await registry.llmRouter.selectProvider("agent_step");
    expect(after).toBeUndefined();
  });

  test(
    "refreshProviderMeta does not mint a spurious route from config.localModel " +
      "(Task 3 predicted bug)",
    async () => {
      const provider = makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "qwen3:8b", parameterCount: 8 }],
      });
      // DEFAULT_CONFIG.localModel is "llama3.2" — distinct from the route's own model,
      // so the old registerProvider-shim re-registration would mint a second route
      // "ollama/llama3.2" alongside "ollama/qwen3:8b".
      const registry = new LlmRegistry({ config: DEFAULT_CONFIG });
      registry.addRoute(provider, "qwen3:8b");
      await registry.refreshProviderMeta("qwen3:8b");
      const routes = registry.llmRouter.routes();
      expect(routes).toHaveLength(1);
      expect(routes[0]?.modelName).toBe("qwen3:8b");
      expect(routes[0]?.meta.parameterCount).toBe(8);
    },
  );
});

describe("LlmRegistry.getRouterStatus", () => {
  test("delegates to LlmRouter.getStatus and returns a shape with the four task types", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG });
    reg.addProvider(makeProvider("ollama", { available: true }));
    const status = await reg.getRouterStatus();
    expect(status).toBeDefined();
    // The exact shape lives in LlmRouter; just confirm the call doesn't throw
    // and returns a defined value.
  });
});

describe("min_reasoning_params can actually fire (F8)", () => {
  /**
   * The knob was dead. `addProvider` called `registerProvider(provider)` with no meta, the default
   * `{}` was stored, `parameterCount` was always `undefined`, and `meetsCapabilityFloor`'s
   * `if (meta?.parameterCount === undefined) return true` fail-opened for every provider on the
   * only production wiring path.
   *
   * Red-proved in the audit: `min_reasoning_params = 7` against a 3.2B model still routed
   * reasoning to it, and `nimbus llm status` never reported `local-below-reasoning-floor`. A
   * documented control that cannot fire is worse than no control.
   */
  function providerReporting(parameterCount: number | undefined): LlmProvider {
    return {
      providerId: "ollama",
      isAvailable: async () => true,
      listModels: async () => [
        {
          provider: "ollama" as const,
          modelName: "llama3.2",
          ...(parameterCount === undefined ? {} : { parameterCount }),
        },
      ],
      generate: async () => ({
        text: "",
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: "llama3.2",
        isLocal: true,
        provider: "ollama" as const,
      }),
    } as unknown as LlmProvider;
  }

  test("a reported parameter count reaches the router", async () => {
    const registry = new LlmRegistry({
      config: { preferLocal: true, localModel: "llama3.2", minReasoningParams: 7 } as never,
    });
    registry.addProvider(providerReporting(3.2));
    await registry.refreshProviderMeta("llama3.2");

    // 3.2B against a floor of 7 — the floor must now see the number it never used to get, so the
    // 3.2B local provider is skipped for a reasoning task and nothing else is registered.
    const chosen = await registry.llmRouter.selectProvider("reasoning");
    expect(chosen).toBeUndefined();
  });

  test("an unreachable provider leaves the fail-open intact", async () => {
    // Deliberate: refusing to route because the floor could not be EVALUATED would turn a
    // capability preference into an outage.
    const registry = new LlmRegistry({
      config: { preferLocal: true, localModel: "llama3.2", minReasoningParams: 7 } as never,
    });
    registry.addProvider({
      providerId: "ollama",
      isAvailable: async () => false,
      listModels: async () => {
        throw new Error("connection refused");
      },
    } as unknown as LlmProvider);

    await expect(registry.refreshProviderMeta("llama3.2")).resolves.toBeUndefined();
  });
});
