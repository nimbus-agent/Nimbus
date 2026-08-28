import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import { wrapLedgeredProvider } from "../egress/model-egress.ts";
import type { RouteAvailability } from "./route-availability.ts";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import { LlmRouter, type LlmRouterConfig, type ProviderMeta } from "./router.ts";
import type {
  LlmModelInfo,
  LlmProvider,
  ModelRoute,
  ProviderId,
  PullProgressChunk,
} from "./types.ts";

export type LlmRegistryOptions = {
  config: LlmRouterConfig;
  db?: Database;
};

/**
 * Optional discriminator for the providerId-keyed lifecycle calls (`pullModel`/`loadModel`/
 * `unloadModel`). Names the exact registered route — and therefore the exact daemon — the
 * operation must reach, for the case where one vendor id has several distinct provider
 * INSTANCES behind it (two Ollama daemons at different base URLs). Omitted, the vendor id must
 * resolve unambiguously or the call throws naming the candidates; see
 * `resolveLifecycleProvider`.
 */
export type LlmLifecycleTarget = { routeId?: string };

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

  /**
   * Registers a route under an explicit model name, ledgered (I29).
   *
   * Wrapping happens HERE and not in `LlmRouter.registerRoute`, because
   * `refreshProviderMeta` below re-registers an ALREADY-WRAPPED provider through
   * `registerRoute` to update its meta -- wrapping there would wrap the wrapper and append
   * two rows per generate. Static rule D22(e) pins `registerRoute` to this file so no other
   * caller can enter the route table unwrapped.
   */
  addRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void {
    this.router.registerRoute(this.ledgered(provider, modelName), modelName, meta ?? {});
  }

  /**
   * `wrapLedgeredProvider` needs a `Database`, and `LlmRegistryOptions.db` is OPTIONAL — so
   * `addRoute` has to answer what a non-local provider means when there is no ledger to
   * append to. It REFUSES. Registering it unwrapped would put an unrecorded egress path in
   * the route table, which is precisely the false zero `nimbus prove` would then report a
   * clean window over; and a refusal at registration is louder, earlier, and easier to
   * diagnose than a missing row discovered months later.
   *
   * This is the ONE place outside `wrapLedgeredProvider` that reads `isLocal`, and it is not
   * a second locality decision: the wrapper still decides what gets LEDGERED. This decides
   * only whether a db is REQUIRED, and its answer for a local provider is "no" — which is
   * what keeps every db-less local-only registry (all of `registry.test.ts`, `assemble.ts`'s
   * pre-db paths) working unchanged.
   *
   * Unreachable in production: `platform/assemble.ts` always constructs the registry with
   * `db`. Slice 2b's bearer-key clouds inherit the guarantee for free.
   */
  private ledgered(provider: LlmProvider, modelName: string): LlmProvider {
    if (provider.isLocal) {
      return provider;
    }
    const db = this.db;
    if (db === undefined) {
      throw new Error(
        `Refusing to register non-local LLM route "${provider.providerId}/${modelName}" ` +
          "without a database: its egress could not be recorded in egress_ledger (I29).",
      );
    }
    return wrapLedgeredProvider(db, provider, modelName);
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
    // Iterates registered routes rather than a fixed ollama/llamacpp id pair, and
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

  /**
   * Availability of one registered route, answered through the probe THIS registry owns — the
   * same instance `LlmRouter` was constructed with, and therefore the same cache route selection
   * consults.
   *
   * Exists because `ipc/llm-rpc.ts`'s `llm.status` used to construct a `RouteAvailabilityProbe`
   * of its own per request. That bypassed the shared cache entirely and could report a DIFFERENT
   * availability snapshot than the one the router had just routed on — "ollama/qwen3:8b:
   * available" in `nimbus llm status` while `nimbus ask` was answering from the fallback,
   * with nothing to reconcile the two. Threading it through the registry (which already holds
   * the reference, for `pullModel`'s `invalidate()`) rather than adding a public probe accessor
   * to `LlmRouter` keeps the reach-into-router-internals shape out of the IPC layer.
   */
  async checkRoute(route: ModelRoute): Promise<RouteAvailability> {
    return await this.probe.check(route);
  }

  /**
   * Resolves which provider INSTANCE a lifecycle call (`pullModel`/`loadModel`/`unloadModel`)
   * must reach.
   *
   * The constraint that shaped this: pulling a model that has NO route yet is the PRIMARY use of
   * pull, so lifecycle cannot key on `routeId` — the model being pulled has no route by
   * definition. Keying on `providerId` alone was the previous answer, resolved with a
   * first-match `.find(...)`; with two Ollama daemons registered at different base URLs that
   * silently sent the pull to whichever was configured FIRST, downloading gigabytes onto the
   * wrong machine with a success message.
   *
   * The resolution keeps vendor-id addressing (so route-less pulls still work) and closes the
   * silent-wrong-target hole by refusing to guess:
   *
   * - one provider instance carries the vendor id → use it (the overwhelmingly common case, and
   *   the one every existing caller is in);
   * - several distinct instances carry it → THROW, naming every candidate route, rather than
   *   picking one. An ambiguous pull has no safe default: both answers are a multi-gigabyte
   *   download against a daemon the user may not have meant;
   * - `target.routeId` supplied → that route's provider, after checking the route exists and
   *   actually belongs to `providerId` (a mismatch is a caller bug, not a silent override).
   */
  private resolveLifecycleProvider(
    providerId: ProviderId,
    target: LlmLifecycleTarget,
  ): LlmProvider {
    const routeId = target.routeId;
    if (routeId !== undefined) {
      const route = this.router.routeFor(routeId);
      if (route === undefined) throw new Error(`Route not registered: ${routeId}`);
      if (route.provider.providerId !== providerId) {
        throw new Error(
          `Route "${routeId}" belongs to provider "${route.provider.providerId}", not "${providerId}"`,
        );
      }
      return route.provider;
    }
    const instances: Array<{ provider: LlmProvider; routeIds: string[] }> = [];
    for (const route of this.router.routes()) {
      if (route.provider.providerId !== providerId) continue;
      const existing = instances.find((e) => e.provider === route.provider);
      if (existing === undefined) {
        instances.push({ provider: route.provider, routeIds: [route.routeId] });
      } else {
        existing.routeIds.push(route.routeId);
      }
    }
    const first = instances[0];
    if (first === undefined) throw new Error(`Provider not registered: ${providerId}`);
    if (instances.length === 1) return first.provider;
    const candidates = instances.map((e) => e.routeIds.join(" + ")).join("; ");
    throw new Error(
      `Provider "${providerId}" is registered on ${instances.length} distinct endpoints — ` +
        `pass routeId to name which one. Candidates: ${candidates}`,
    );
  }

  // Lifecycle methods key on `providerId`, and the model stays an argument — never the
  // route id. `OllamaProvider.pullModel(modelName)` posts its argument to the shared
  // daemon, so any registered instance of a providerId can pull/load/unload any model;
  // requiring a matching route would make it impossible to pull a model that has no
  // route yet, which is the primary use of pull. `target.routeId` is the optional
  // tie-breaker for when one vendor id has several daemons — see
  // `resolveLifecycleProvider`, which refuses to guess rather than taking the first.
  async loadModel(
    provider: ProviderId,
    modelName: string,
    target: LlmLifecycleTarget = {},
  ): Promise<void> {
    const p = this.resolveLifecycleProvider(provider, target);
    if (typeof (p as unknown as { loadModel?: unknown }).loadModel === "function") {
      await (p as unknown as { loadModel: (m: string) => Promise<void> }).loadModel(modelName);
    }
    // Ollama auto-loads on first generate; this is a no-op for Ollama.
  }

  async unloadModel(
    provider: ProviderId,
    modelName: string,
    target: LlmLifecycleTarget = {},
  ): Promise<void> {
    const p = this.resolveLifecycleProvider(provider, target);
    if (typeof (p as unknown as { unloadModel?: unknown }).unloadModel === "function") {
      await (p as unknown as { unloadModel: (m: string) => Promise<void> }).unloadModel(modelName);
    }
  }

  async pullModel(
    provider: ProviderId,
    modelName: string,
    opts: {
      signal?: AbortSignal;
      onProgress?: (p: PullProgressChunk) => void;
      routeId?: string;
    } = {},
  ): Promise<void> {
    const { routeId, ...providerOpts } = opts;
    // Spread-conditional rather than `{ routeId }`: under `exactOptionalPropertyTypes`, an
    // explicit `routeId: undefined` is a different type from an absent key.
    const p = this.resolveLifecycleProvider(provider, routeId === undefined ? {} : { routeId });
    if (typeof p.pullModel !== "function") {
      throw new TypeError(`Provider ${provider} does not support pullModel`);
    }
    // `routeId` is a REGISTRY-side discriminator; it is destructured off above rather than
    // forwarded, so no provider ever receives a key its own `pullModel` contract does not name.
    await p.pullModel(modelName, providerOpts);
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
