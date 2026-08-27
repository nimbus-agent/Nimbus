import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import { LlmRouter, type LlmRouterConfig, type ProviderMeta } from "./router.ts";
import type { LlmModelInfo, LlmProvider, ProviderId, PullProgressChunk } from "./types.ts";

export type LlmRegistryOptions = {
  config: LlmRouterConfig;
  db?: Database;
};

export class LlmRegistry {
  private readonly router: LlmRouter;
  private readonly db: Database | undefined;
  // Constructed here (not by LlmRouter) so the registry keeps its own reference to call
  // `invalidate()` on a successful pullModel — see pullModel below. No public accessor is
  // exposed on LlmRouter for this: that would recreate the reach-into-router-internals
  // shape Task 3 just deleted from this file.
  private readonly probe = new RouteAvailabilityProbe();

  constructor(opts: LlmRegistryOptions) {
    this.router = new LlmRouter(opts.config, this.probe);
    this.db = opts.db;
  }

  addProvider(provider: LlmProvider, meta?: ProviderMeta): void {
    this.router.registerProvider(provider, meta ?? {});
  }

  /** Registers a route with its own model name — the non-deprecated counterpart to
   *  `addProvider`, which derives the model name from `config.localModel`/`config.remoteModel`. */
  addRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void {
    this.router.registerRoute(provider, modelName, meta ?? {});
  }

  /**
   * Populate `parameterCount` for the local providers from what they report, so
   * `[llm] min_reasoning_params` can actually fire (F8).
   *
   * It could not. `addProvider` called `registerProvider(provider)` with no meta, the default `{}`
   * was stored, `parameterCount` was therefore always `undefined`, and `meetsCapabilityFloor`'s
   * `if (meta?.parameterCount === undefined) return true` fail-opened for every provider on the
   * only production wiring path. Red-proved in the audit: `min_reasoning_params = 7` against a
   * 3.2B model still routed reasoning to it, and `nimbus llm status` never reported
   * `local-below-reasoning-floor`.
   *
   * `OllamaProvider.parseOllamaModel` already parses `parameter_size: "3.2B"` correctly — it just
   * fed `listModels()` rather than the router.
   *
   * Best-effort by design, and the fail-open stays: a provider that is down cannot report a
   * parameter count, and refusing to route because the floor could not be EVALUATED would turn a
   * capability preference into an outage. The difference from before is that the floor now fires
   * whenever the information exists.
   */
  async refreshProviderMeta(modelName?: string): Promise<void> {
    // Iterates registered routes rather than a fixed ["ollama", "llamacpp"] id set, and
    // re-registers each matching route through `registerRoute(route.provider,
    // route.modelName, ...)` rather than the deprecated `registerProvider` shim.
    //
    // The shim derives the model name it registers under from `config.localModel` /
    // `config.remoteModel` — fine while every provider had exactly one config-derived
    // route, but once a route is registered with its OWN model name (`addRoute`, Task 9),
    // calling `registerProvider` here would re-register under `config.localModel` instead,
    // MINTING A SPURIOUS second route (`<provider>/<config.localModel>`) alongside the
    // real one on every refresh. Using `route.modelName` targets the exact existing route
    // every time, so re-registration only ever updates that route's meta.
    //
    // `modelName`, when supplied, is a FILTER — refresh only the route(s) whose own
    // `modelName` matches it — never a shared search target applied across every route. The
    // bug this guards against (Task 9 review, finding 1): the previous version searched
    // EVERY local route's provider listing for one caller-supplied `modelName` and stamped
    // whatever it found onto whichever route the loop happened to be on. With two Ollama
    // routes sharing one daemon (`qwen3:8b` and `gemma3:12b`), refreshing "qwen3:8b" also
    // matched while examining the unrelated gemma route and wrote qwen3's parameter count
    // onto gemma's meta — last name processed wins for every route. Matching each route
    // only against ITS OWN `modelName` (never a caller-supplied one) makes that impossible
    // by construction, and lets every local route refresh in one pass with no argument at
    // all — one `listModels()` call per LOCAL ROUTE, not per route × distinct model name.
    for (const route of this.router.routes()) {
      if (!route.provider.isLocal) continue;
      if (modelName !== undefined && route.modelName !== modelName) continue;
      try {
        const models = await route.provider.listModels();
        const match = models.find(
          (m) => m.modelName === route.modelName || m.modelName.startsWith(`${route.modelName}:`),
        );
        if (match?.parameterCount !== undefined) {
          this.router.registerRoute(route.provider, route.modelName, {
            parameterCount: match.parameterCount,
          });
        }
      } catch {
        // Provider unreachable. Leaving meta empty keeps the documented fail-open.
      }
    }
  }

  get llmRouter(): LlmRouter {
    return this.router;
  }

  async listAllModels(): Promise<LlmModelInfo[]> {
    const results: LlmModelInfo[] = [];
    // Dedup by provider INSTANCE (not providerId): a future multi-route provider id
    // (several distinct Ollama daemons, say) must still be listed once per instance, but
    // two routes sharing the same instance must not trigger the same listModels() call
    // twice.
    const seen = new Set<LlmProvider>();
    for (const route of this.router.routes()) {
      const provider = route.provider;
      if (seen.has(provider)) continue;
      seen.add(provider);
      try {
        if (!(await provider.isAvailable())) continue;
        const models = await provider.listModels();
        results.push(...models);
        this.syncModelsToDb(models);
      } catch {
        /* provider error — skip */
      }
    }
    return results;
  }

  async checkAvailability(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    const seen = new Set<ProviderId>();
    for (const route of this.router.routes()) {
      const id = route.provider.providerId;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        result[id] = await route.provider.isAvailable();
      } catch {
        result[id] = false;
      }
    }
    return result;
  }

  // Lifecycle methods key on `providerId`, and the model stays an argument — never the
  // route id. `OllamaProvider.pullModel(modelName)` posts its argument to the shared
  // daemon, so any registered instance of a providerId can pull/load/unload any model;
  // requiring a matching route would make it impossible to pull a model that has no
  // route yet, which is the primary use of pull. Resolution is "any registered route
  // whose provider.providerId matches" — exactly what `LlmRouter.providerFor` does.
  async loadModel(provider: ProviderId, modelName: string): Promise<void> {
    const p = this.router.providerFor(provider);
    if (p === undefined) throw new Error(`Provider not registered: ${provider}`);
    if (typeof (p as unknown as { loadModel?: unknown }).loadModel === "function") {
      await (p as unknown as { loadModel: (m: string) => Promise<void> }).loadModel(modelName);
    }
    // Ollama auto-loads on first generate; this is a no-op for Ollama.
  }

  async unloadModel(provider: ProviderId, modelName: string): Promise<void> {
    const p = this.router.providerFor(provider);
    if (p === undefined) throw new Error(`Provider not registered: ${provider}`);
    if (typeof (p as unknown as { unloadModel?: unknown }).unloadModel === "function") {
      await (p as unknown as { unloadModel: (m: string) => Promise<void> }).unloadModel(modelName);
    }
  }

  async pullModel(
    provider: ProviderId,
    modelName: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void } = {},
  ): Promise<void> {
    const p = this.router.providerFor(provider);
    if (p === undefined) throw new Error(`Provider not registered: ${provider}`);
    if (typeof p.pullModel !== "function") {
      throw new TypeError(`Provider ${provider} does not support pullModel`);
    }
    await p.pullModel(modelName, opts);
    // Only on success: a failed pull must not clear the cache. Without this, a freshly
    // pulled model keeps reporting `model_absent` for up to
    // ROUTE_AVAILABILITY_POSITIVE_TTL_MS, which looks exactly like the pull having failed.
    this.probe.invalidate(provider);
  }

  async setDefault(
    taskType: "classification" | "reasoning" | "summarisation" | "agent_step",
    provider: ProviderId,
    modelName: string,
  ): Promise<void> {
    if (this.db === undefined) return;
    dbRun(
      this.db,
      `INSERT INTO llm_task_defaults (task_type, provider, model_name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_type) DO UPDATE SET
         provider = excluded.provider,
         model_name = excluded.model_name,
         updated_at = excluded.updated_at`,
      [taskType, provider, modelName, Date.now()],
    );
  }

  async getRouterStatus(): Promise<Awaited<ReturnType<LlmRouter["getStatus"]>>> {
    return await this.router.getStatus();
  }

  getDefault(taskType: string): { provider: string; modelName: string } | undefined {
    if (this.db === undefined) return undefined;
    const row = this.db
      .query("SELECT provider, model_name FROM llm_task_defaults WHERE task_type = ?")
      .get(taskType) as { provider: string; model_name: string } | undefined;
    return row === undefined ? undefined : { provider: row.provider, modelName: row.model_name };
  }

  private syncModelsToDb(models: LlmModelInfo[]): void {
    if (this.db === undefined) return;
    const now = Date.now();
    for (const m of models) {
      try {
        dbRun(
          this.db,
          `INSERT INTO llm_models (provider, model_name, parameter_count, context_window, quantization, vram_estimate_mb, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, model_name) DO UPDATE SET
             parameter_count = excluded.parameter_count,
             context_window = excluded.context_window,
             quantization = excluded.quantization,
             vram_estimate_mb = excluded.vram_estimate_mb,
             last_seen_at = excluded.last_seen_at`,
          [
            m.provider,
            m.modelName,
            m.parameterCount ?? null,
            m.contextWindow ?? null,
            m.quantization ?? null,
            m.vramEstimateMb ?? null,
            now,
          ],
        );
      } catch {
        /* best-effort */
      }
    }
  }
}
