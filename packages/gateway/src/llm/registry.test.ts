import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listEgress } from "../egress/egress-verify.ts";
import { LLM_MODELS_V16_SQL } from "../index/llm-models-v16-sql.ts";
import { LLM_TASK_DEFAULTS_V20_SQL } from "../index/llm-task-defaults-v20-sql.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LlmRegistry } from "./registry.ts";
import type { LlmRouterConfig } from "./router.ts";
import type { LlmModelInfo, LlmProvider, ProviderId, PullProgressChunk } from "./types.ts";

// A stand-in remote model name. Was `LlmRouterConfig.remoteModel`, removed on 2026-08-28
// along with `[llm] remote_model`; these tests only ever needed an arbitrary non-local id.
const REMOTE_MODEL = "claude-sonnet-4-6";

const DEFAULT_CONFIG: LlmRouterConfig = {
  preferLocal: true,
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

function makeProvider(id: ProviderId, opts: ProviderOpts): LlmProvider {
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

/**
 * A database for the ROUTING-only tests.
 *
 * `LlmRegistryOptions.db` became required (#1356) so an unledgered non-local route is a compile
 * error rather than a runtime refusal. These tests register LOCAL providers only, and
 * `wrapLedgeredProvider` returns a local provider UNCHANGED without touching the handle — so a
 * bare in-memory database with no schema is sufficient, and they stay as cheap as they were when
 * they passed nothing. A test that registers a non-local provider needs `makeDbWithSchema()`
 * below instead, because the wrapper will really append to `egress_ledger`.
 */
const ROUTING_DB = new Database(":memory:");

function makeDbWithSchema(): { db: Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-registry-"));
  const db = new Database(join(dir, "test.db"));
  db.exec(LLM_MODELS_V16_SQL.replace(/ALTER TABLE.*$/m, ""));
  db.exec(LLM_TASK_DEFAULTS_V20_SQL);
  return { db, dir };
}

describe("LlmRegistry — construction + provider registration", () => {
  test("exposes the underlying LlmRouter via llmRouter getter", () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    expect(reg.llmRouter).toBeDefined();
    expect(typeof reg.llmRouter.selectProvider).toBe("function");
  });

  test("addRoute registers a provider that selectProvider can then resolve", () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    // The model-aware availability probe (Task 5) needs the fake to report the model it is
    // registered under, or it reads as unavailable.
    reg.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: DEFAULT_CONFIG.localModel }],
      }),
      DEFAULT_CONFIG.localModel,
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
    reg.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "llama3.2", parameterCount: 3 }],
      }),
      DEFAULT_CONFIG.localModel,
    );
    reg.addRoute(
      makeProvider("llamacpp", {
        available: true,
        models: [{ provider: "llamacpp", modelName: "qwen", contextWindow: 8192 }],
      }),
      DEFAULT_CONFIG.localModel,
    );
    reg.addRoute(
      makeProvider("remote", {
        available: true,
        models: [{ provider: "remote", modelName: "claude-sonnet-4-6" }],
      }),
      REMOTE_MODEL,
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
    reg.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "m1" }],
      }),
      DEFAULT_CONFIG.localModel,
    );
    reg.addRoute(
      makeProvider("llamacpp", {
        available: false,
        models: [{ provider: "llamacpp", modelName: "m2" }],
      }),
      DEFAULT_CONFIG.localModel,
    );
    const models = await reg.listAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.provider).toBe("ollama");
  });

  test("a thrown provider error is swallowed (skip silently)", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addRoute(
      makeProvider("ollama", { available: true, throwOnList: true }),
      DEFAULT_CONFIG.localModel,
    );
    reg.addRoute(
      makeProvider("remote", {
        available: true,
        models: [{ provider: "remote", modelName: "good" }],
      }),
      REMOTE_MODEL,
    );
    const models = await reg.listAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.modelName).toBe("good");
  });

  test("syncs models to llm_models table on each listAllModels call", async () => {
    env = makeDbWithSchema();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: env.db });
    reg.addRoute(
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
      DEFAULT_CONFIG.localModel,
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
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    reg.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "x" }],
      }),
      DEFAULT_CONFIG.localModel,
    );
    await expect(reg.listAllModels()).resolves.toBeDefined();
  });
});

describe("LlmRegistry.checkAvailability", () => {
  test("returns per-provider booleans for registered providers", async () => {
    // A db is required only because this case registers a NON-LOCAL ("remote") provider, and
    // `addRoute` refuses to enter one in the route table with no ledger to append to (I29).
    const db = freshLedgerDb();
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db });
    reg.addRoute(makeProvider("ollama", { available: true }), DEFAULT_CONFIG.localModel);
    reg.addRoute(makeProvider("remote", { available: false }), REMOTE_MODEL);
    const out = await reg.checkAvailability();
    expect(out["ollama"]).toBe(true);
    expect(out["remote"]).toBe(false);
    expect(out["llamacpp"]).toBeUndefined();
    db.close();
  });

  test("isAvailable throw → false for that provider", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    reg.addRoute(
      makeProvider("ollama", { available: false, throwOnAvailable: true }),
      DEFAULT_CONFIG.localModel,
    );
    const out = await reg.checkAvailability();
    expect(out["ollama"]).toBe(false);
  });
});

describe("LlmRegistry.loadModel / unloadModel", () => {
  test("loadModel invokes the provider's loadModel when defined", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    let captured = "";
    reg.addRoute(
      makeProvider("llamacpp", {
        available: true,
        loadModel: async (m) => {
          captured = m;
        },
      }),
      DEFAULT_CONFIG.localModel,
    );
    await reg.loadModel("llamacpp", "qwen.gguf");
    expect(captured).toBe("qwen.gguf");
  });

  test("loadModel is a no-op when the provider does not implement it", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    reg.addRoute(makeProvider("ollama", { available: true }), DEFAULT_CONFIG.localModel);
    await expect(reg.loadModel("ollama", "any-model")).resolves.toBeUndefined();
  });

  test("loadModel throws when provider is not registered", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    await expect(reg.loadModel("ollama", "x")).rejects.toThrow("Provider not registered: ollama");
  });

  test("unloadModel invokes the provider's unloadModel when defined", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    let captured = "";
    reg.addRoute(
      makeProvider("llamacpp", {
        available: true,
        unloadModel: async (m) => {
          captured = m;
        },
      }),
      DEFAULT_CONFIG.localModel,
    );
    await reg.unloadModel("llamacpp", "qwen.gguf");
    expect(captured).toBe("qwen.gguf");
  });

  test("unloadModel throws for unregistered provider", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    await expect(reg.unloadModel("llamacpp", "x")).rejects.toThrow(
      "Provider not registered: llamacpp",
    );
  });
});

describe("LlmRegistry.pullModel", () => {
  test("dispatches to provider.pullModel when supported", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    let captured = "";
    reg.addRoute(
      makeProvider("ollama", {
        available: true,
        pullModel: async (m) => {
          captured = m;
        },
      }),
      DEFAULT_CONFIG.localModel,
    );
    await reg.pullModel("ollama", "llama3.2");
    expect(captured).toBe("llama3.2");
  });

  test("rejects with TypeError when provider lacks pullModel", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    reg.addRoute(makeProvider("llamacpp", { available: true }), DEFAULT_CONFIG.localModel);
    await expect(reg.pullModel("llamacpp", "x")).rejects.toThrow(
      "Provider llamacpp does not support pullModel",
    );
  });

  test("rejects when provider is not registered", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    await expect(reg.pullModel("ollama", "x")).rejects.toThrow("Provider not registered: ollama");
  });
});

// `LlmRegistry.setDefault` was removed with #1383. Its two tests asserted an UPSERT into
// `llm_task_defaults` — a table that had a writer and no reader, so they proved the write
// happened while the setting it represented did nothing. The behaviour that replaced it is
// covered where it now lives, in `ipc/llm-rpc.test.ts`: `llm.setDefault` writes `[llm.tasks]`,
// updates the live router, and refuses an unregistered route or a missing config path.
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
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(provider, "qwen3:8b");
    await registry.pullModel("ollama", "a-model-with-no-route");
    expect(pulled).toEqual(["a-model-with-no-route"]);
  });

  test("listAllModels covers a vendor id the registry has never heard of", async () => {
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
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
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
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
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
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
      const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
      registry.addRoute(provider, "qwen3:8b");
      await registry.refreshProviderMeta("qwen3:8b");
      const routes = registry.llmRouter.routes();
      expect(routes).toHaveLength(1);
      expect(routes[0]?.modelName).toBe("qwen3:8b");
      expect(routes[0]?.meta.parameterCount).toBe(8);
    },
  );

  test(
    "refreshProviderMeta does not cross-assign parameterCount between routes sharing a " +
      "daemon (Task 9 review, finding 1)",
    async () => {
      // Two DISTINCT provider instances (as `buildLlmRegistryFromToml` constructs, one per
      // [llm.local.*] entry) both pointed at the same shared Ollama daemon — so both report
      // the daemon's FULL model list, exactly as a real shared daemon would.
      const sharedDaemonListing: LlmModelInfo[] = [
        { provider: "ollama", modelName: "qwen3:8b", parameterCount: 8 },
        { provider: "ollama", modelName: "gemma3:12b", parameterCount: 12 },
      ];
      const qwenProvider = makeProvider("ollama", {
        available: true,
        models: sharedDaemonListing,
      });
      const gemmaProvider = makeProvider("ollama", {
        available: true,
        models: sharedDaemonListing,
      });
      const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
      registry.addRoute(qwenProvider, "qwen3:8b");
      registry.addRoute(gemmaProvider, "gemma3:12b");

      // Mirrors the ACTUAL pre-fix production call pattern in assemble.ts: one call per
      // distinct registered model name, looped across every route.
      await registry.refreshProviderMeta("qwen3:8b");
      await registry.refreshProviderMeta("gemma3:12b");

      const routes = registry.llmRouter.routes();
      const qwenRoute = routes.find((r) => r.modelName === "qwen3:8b");
      const gemmaRoute = routes.find((r) => r.modelName === "gemma3:12b");
      // Each route must get its OWN parameterCount — never the other route's, which is
      // exactly what a caller-supplied `modelName` search applied indiscriminately to every
      // route (rather than matched against that route's own modelName) produced: whichever
      // name was refreshed LAST won for every route on the shared daemon.
      expect(qwenRoute?.meta.parameterCount).toBe(8);
      expect(gemmaRoute?.meta.parameterCount).toBe(12);
    },
  );
});

describe("LlmRegistry.getRouterStatus", () => {
  test("delegates to LlmRouter.getStatus and returns a shape with the four task types", async () => {
    const reg = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    reg.addRoute(makeProvider("ollama", { available: true }), DEFAULT_CONFIG.localModel);
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
      // Required so `refreshProviderMeta`'s `if (!route.provider.isLocal) continue` does not
      // skip this route — without it, parameterCount is never propagated to route.meta at
      // all, and the test below passed for the wrong reason (the route read as unavailable
      // via a route-id/modelName mismatch in the now-deleted `registerProvider` shim, not
      // because the capability floor actually rejected the reported parameter count).
      isLocal: true,
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
      db: ROUTING_DB,
    });
    registry.addRoute(providerReporting(3.2), DEFAULT_CONFIG.localModel);
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
      db: ROUTING_DB,
    });
    registry.addRoute(
      {
        providerId: "ollama",
        isLocal: true,
        isAvailable: async () => false,
        listModels: async () => {
          throw new Error("connection refused");
        },
      } as unknown as LlmProvider,
      DEFAULT_CONFIG.localModel,
    );

    await expect(registry.refreshProviderMeta("llama3.2")).resolves.toBeUndefined();
  });
});

describe("LlmRegistry lifecycle — two daemons behind one vendor id (Fix I)", () => {
  test("an unambiguous vendor id still resolves with no discriminator", async () => {
    // The constraint that shapes this whole design: pulling a model that has NO route yet
    // must keep working, so lifecycle cannot key on routeId. One instance → no ambiguity.
    const pulled: string[] = [];
    const provider = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        pulled.push(m);
      },
    });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    // Two ROUTES, one provider INSTANCE — the ordinary two-models-on-one-daemon setup.
    registry.addRoute(provider, "qwen3:8b");
    registry.addRoute(provider, "gemma3:12b");
    await registry.pullModel("ollama", "a-model-with-no-route");
    expect(pulled).toEqual(["a-model-with-no-route"]);
  });

  test("two distinct daemons under one vendor id REFUSE to guess, and name the candidates", async () => {
    // The bug: `.find(...)` on providerId sent the pull to whichever daemon was configured
    // FIRST — a multi-gigabyte download onto the wrong machine, reported as success.
    const laptopPulls: string[] = [];
    const workstationPulls: string[] = [];
    const laptop = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        laptopPulls.push(m);
      },
    });
    const workstation = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        workstationPulls.push(m);
      },
    });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(laptop, "qwen3:8b");
    registry.addRoute(workstation, "gemma3:12b");

    await expect(registry.pullModel("ollama", "new-model")).rejects.toThrow(/2 distinct endpoints/);
    // Naming the candidates is the point — an error the user cannot act on is barely better
    // than the silent wrong answer it replaced.
    await expect(registry.pullModel("ollama", "new-model")).rejects.toThrow(/ollama\/qwen3:8b/);
    await expect(registry.pullModel("ollama", "new-model")).rejects.toThrow(/ollama\/gemma3:12b/);
    // And NOTHING was downloaded anywhere: refusing means refusing, not "tried the first one".
    expect(laptopPulls).toEqual([]);
    expect(workstationPulls).toEqual([]);
  });

  test("routeId names which daemon the operation reaches", async () => {
    const laptopPulls: string[] = [];
    const workstationPulls: string[] = [];
    const laptop = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        laptopPulls.push(m);
      },
    });
    const workstation = makeProvider("ollama", {
      available: true,
      pullModel: async (m) => {
        workstationPulls.push(m);
      },
    });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(laptop, "qwen3:8b");
    registry.addRoute(workstation, "gemma3:12b");

    await registry.pullModel("ollama", "new-model", { routeId: "ollama/gemma3:12b" });
    expect(workstationPulls).toEqual(["new-model"]);
    expect(laptopPulls).toEqual([]);
  });

  test("loadModel/unloadModel resolve through the same rule", async () => {
    const loaded: string[] = [];
    const unloaded: string[] = [];
    const laptop = makeProvider("ollama", { available: true, loadModel: async () => {} });
    const workstation = makeProvider("ollama", {
      available: true,
      loadModel: async (m) => {
        loaded.push(m);
      },
      unloadModel: async (m) => {
        unloaded.push(m);
      },
    });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(laptop, "qwen3:8b");
    registry.addRoute(workstation, "gemma3:12b");

    await expect(registry.loadModel("ollama", "x")).rejects.toThrow(/2 distinct endpoints/);
    await registry.loadModel("ollama", "x", { routeId: "ollama/gemma3:12b" });
    expect(loaded).toEqual(["x"]);
    await registry.unloadModel("ollama", "x", { routeId: "ollama/gemma3:12b" });
    expect(unloaded).toEqual(["x"]);
  });

  test("an unregistered routeId is rejected rather than silently ignored", async () => {
    const provider = makeProvider("ollama", { available: true, pullModel: async () => {} });
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(provider, "qwen3:8b");
    await expect(
      registry.pullModel("ollama", "x", { routeId: "ollama/not-registered" }),
    ).rejects.toThrow("Route not registered: ollama/not-registered");
  });

  test("a routeId belonging to a DIFFERENT provider is rejected, never used as an override", async () => {
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(makeProvider("ollama", { available: true }), "qwen3:8b");
    registry.addRoute(makeProvider("llamacpp", { available: true }), "a.gguf");
    await expect(registry.loadModel("ollama", "x", { routeId: "llamacpp/a.gguf" })).rejects.toThrow(
      /belongs to provider "llamacpp", not "ollama"/,
    );
  });
});

describe("LlmRegistry.checkRoute — the registry owns the probe (Fix E)", () => {
  test("checkRoute answers from the SAME probe route selection consults", async () => {
    // The property `llm.status` needs: one probe, one answer. A `RouteAvailabilityProbe`
    // constructed at the IPC layer had its own cache, so status could report a route
    // available while the router had already routed past it.
    let listCalls = 0;
    let reportedModels: string[] = [];
    const provider = makeProvider("ollama", { available: true, models: [] });
    (provider as unknown as { listModels: () => Promise<LlmModelInfo[]> }).listModels =
      async () => {
        listCalls += 1;
        return reportedModels.map((m) => ({ provider: "ollama", modelName: m }));
      };
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(provider, "fresh-model");
    const route = registry.llmRouter.routes()[0];
    expect(route).toBeDefined();

    // Prime the shared cache through the ROUTER.
    expect(await registry.llmRouter.selectProvider("agent_step")).toBeUndefined();
    const callsAfterRouting = listCalls;
    // The daemon now reports the model — but the shared cache has not expired, so a probe
    // reading the same cache must still say `model_absent`. A freshly-constructed probe
    // would re-list and answer `ok`, which is exactly the divergence this closes.
    reportedModels = ["fresh-model"];
    expect(await registry.checkRoute(route as NonNullable<typeof route>)).toEqual({
      available: false,
      reason: "model_absent",
    });
    expect(listCalls).toBe(callsAfterRouting);
  });
});

/**
 * A db carrying the REAL schema, via the migration runner — `egress_ledger` included, and
 * with the chain triggers/indices `appendEgressEntry` actually runs against. The file's
 * older `makeDbWithSchema()` hand-rolls two tables and predates the ledger, so it cannot
 * back these tests.
 */
function freshLedgerDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

describe("LlmRegistry — egress ledgering of non-local routes (I29)", () => {
  test("addRoute ledgers a remote route's generate exactly once", async () => {
    // The end-to-end shape of the wiring: registry -> router -> provider, one row.
    const db = freshLedgerDb();
    const registry = new LlmRegistry({ db, config: DEFAULT_CONFIG });
    registry.addRoute(
      makeProvider("remote", {
        available: true,
        models: [{ provider: "remote", modelName: "claude-sonnet-4-6" }],
      }),
      "claude-sonnet-4-6",
    );

    await registry.llmRouter.generate({ task: "reasoning", prompt: "hi" });

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "model",
      sourceId: "claude-sonnet-4-6",
      destination: "remote",
      method: "llm.generate.reasoning",
      resultStatus: "authorized",
    });
    db.close();
  });

  test("a LOCAL route's generate appends nothing", async () => {
    // The other half of the derivation: local inference makes no outbound request, so
    // ledgering it would over-claim egress.
    const db = freshLedgerDb();
    const registry = new LlmRegistry({ db, config: DEFAULT_CONFIG });
    registry.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "llama3.2" }],
      }),
      "llama3.2",
    );

    await registry.llmRouter.generate({ task: "reasoning", prompt: "hi" });

    expect(listEgress(db, {})).toHaveLength(0);
    db.close();
  });

  test("refreshProviderMeta does not double-wrap", async () => {
    // `refreshProviderMeta` re-registers a route's provider through `registerRoute`. If the
    // wrap ever moved there, this would append two rows per generate.
    const db = freshLedgerDb();
    const registry = new LlmRegistry({ db, config: DEFAULT_CONFIG });
    registry.addRoute(
      makeProvider("ollama", {
        available: true,
        models: [{ provider: "ollama", modelName: "qwen3:8b", parameterCount: 8 }],
      }),
      "qwen3:8b",
    );
    await registry.refreshProviderMeta();
    expect(registry.llmRouter.routes()).toHaveLength(1);
    db.close();
  });

  test("db is REQUIRED at COMPILE time, so an unledgered non-local route cannot be built", () => {
    // The runtime refusal this replaces ("without a database") is gone, because the state it
    // guarded is now unconstructable. This is the guard that took its place, and it is checked
    // by `bun run typecheck`, not at runtime: if `db` ever became optional again, the
    // `@ts-expect-error` below would report an UNUSED directive and fail the typecheck. That is
    // the whole point — the protection moved from a throw to the type, so the test moved too.
    // @ts-expect-error -- `db` is required; omitting it must not compile.
    const build = () => new LlmRegistry({ config: DEFAULT_CONFIG });
    expect(typeof build).toBe("function");
  });

  test("a LOCAL route still registers without a db", () => {
    // The refusal must be scoped to non-local providers: a local-only registry is a
    // legitimate configuration and every existing db-less test depends on it.
    const registry = new LlmRegistry({ config: DEFAULT_CONFIG, db: ROUTING_DB });
    registry.addRoute(makeProvider("ollama", { available: true }), "llama3.2");
    expect(registry.llmRouter.routes()).toHaveLength(1);
  });
});
