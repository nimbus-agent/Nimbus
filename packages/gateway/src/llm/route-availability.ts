import type { LlmProvider, ModelRoute, ProviderId } from "./types.ts";

/**
 * Why a route is or isn't usable, kept as two distinct failure reasons rather than a
 * single "unavailable" boolean — they have different fixes. `provider_unreachable`
 * means the daemon is down (start Ollama / llama.cpp). `model_absent` means the
 * daemon is up but the configured model was never pulled (`nimbus llm pull`).
 * Collapsing the two sends the user to the wrong remedy.
 */
export type RouteAvailability = {
  available: boolean;
  reason: "ok" | "provider_unreachable" | "model_absent";
};

/**
 * TTL for a cached probe result when the daemon WAS reachable — covers both `ok` and
 * `model_absent`. Long: a model list only changes when someone pulls a model (which
 * `invalidate()` handles immediately, without waiting out this TTL) or removes one
 * out-of-band, so resolving a several-route table over one daemon can safely cost one
 * `/api/tags` call per 30s rather than one per route per resolution.
 */
export const ROUTE_AVAILABILITY_POSITIVE_TTL_MS = 30_000;

/**
 * TTL for a cached probe result when the daemon was UNREACHABLE. Deliberately much
 * shorter than the positive TTL, not the same value and not zero:
 *
 * - Short, not the 30s positive TTL: a down daemon is a fast-changing state a user is
 *   actively waiting on (`ollama serve` then immediately `nimbus llm status`) — caching
 *   "unreachable" for 30s would make a freshly-started daemon read as broken for up to
 *   30 seconds, which is indistinguishable from an actual outage from the user's seat.
 * - Not zero: with the daemon actually down, an UNcached probe costs one failed HTTP
 *   attempt per route per resolution (each Ollama/llama.cpp `isAvailable()` call pays
 *   its own connection-refused/timeout latency) — some negative caching is still
 *   worth having, just far less of it than the positive case.
 */
export const ROUTE_AVAILABILITY_NEGATIVE_TTL_MS = 2_000;

// What a single `/api/tags`-shaped probe of a provider daemon establishes: whether it
// answered at all, and — only if it did — what models it currently reports. Cached
// per `providerId`, not per route: the model list is a property of the daemon a route's
// provider talks to, not of any one route, so four routes sharing one Ollama daemon
// must cost one round trip, not four.
type ProviderProbeResult = {
  reachable: boolean;
  modelNames: readonly string[];
};

type CacheEntry = {
  result: Promise<ProviderProbeResult>;
  // Mutable: set to a provisional (positive-TTL) value when the entry is created so a
  // burst of concurrent `check()` calls for the same provider shares one in-flight
  // fetch, then corrected once the result resolves — a rejected daemon gets the much
  // shorter negative TTL (Finding B), which cannot be known until the fetch settles.
  expiresAt: number;
};

/**
 * Answers "is this route actually usable right now?" — the daemon is reachable AND the
 * route's `modelName` is among the models that daemon currently reports. Deliberately
 * does NOT pull a missing model: falling through to the next configured route is
 * correct; silently starting a multi-gigabyte download because a config entry named a
 * model is not.
 *
 * Caches the per-provider probe (reachability + model list) keyed on `providerId`, for
 * `positiveTtlMs` when the daemon answered or `negativeTtlMs` when it didn't — see the
 * two constants above for why they differ. `invalidate(providerId)` exists so a
 * successful `LlmRegistry.pullModel` can drop the cache immediately rather than making
 * the caller wait out the TTL to see a model it just pulled.
 */
export class RouteAvailabilityProbe {
  private readonly cache = new Map<ProviderId, CacheEntry>();

  constructor(
    private readonly positiveTtlMs: number = ROUTE_AVAILABILITY_POSITIVE_TTL_MS,
    private readonly negativeTtlMs: number = ROUTE_AVAILABILITY_NEGATIVE_TTL_MS,
  ) {}

  async check(route: ModelRoute): Promise<RouteAvailability> {
    const probe = await this.probeProvider(route.provider);
    if (!probe.reachable) {
      return { available: false, reason: "provider_unreachable" };
    }
    if (matchesModel(probe.modelNames, route.modelName)) {
      return { available: true, reason: "ok" };
    }
    return { available: false, reason: "model_absent" };
  }

  /** Drops the cached probe for `providerId`, so the next `check()` re-lists. */
  invalidate(providerId: ProviderId): void {
    this.cache.delete(providerId);
  }

  private probeProvider(provider: LlmProvider): Promise<ProviderProbeResult> {
    const now = Date.now();
    const cached = this.cache.get(provider.providerId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }
    const result = fetchProviderProbe(provider);
    // Provisional entry, cached under the positive TTL so concurrent callers share
    // this fetch; `entry` is the SAME object stored in the map, so mutating its
    // `expiresAt` below is visible to every future `probeProvider` lookup once the
    // fetch settles. `fetchProviderProbe` never rejects (it catches both awaits
    // internally), so no `.catch()` is needed here.
    const entry: CacheEntry = { result, expiresAt: now + this.positiveTtlMs };
    this.cache.set(provider.providerId, entry);
    void result.then((r) => {
      entry.expiresAt = Date.now() + (r.reachable ? this.positiveTtlMs : this.negativeTtlMs);
    });
    return result;
  }
}

async function fetchProviderProbe(provider: LlmProvider): Promise<ProviderProbeResult> {
  let reachable: boolean;
  try {
    reachable = await provider.isAvailable();
  } catch {
    reachable = false;
  }
  if (!reachable) {
    return { reachable: false, modelNames: [] };
  }
  try {
    const models = await provider.listModels();
    return { reachable: true, modelNames: models.map((m) => m.modelName) };
  } catch {
    // The daemon answered `isAvailable()` but failed to list its models — treat this
    // the same as unreachable rather than as "model absent", since we could not
    // actually determine which models it holds. Reporting `model_absent` here would
    // send the user to `nimbus llm pull`, which is the wrong fix for a flaky daemon.
    return { reachable: false, modelNames: [] };
  }
}

// Exact match first, then tag-tolerant: `name.startsWith(`${modelName}:`)`. Mirrors the
// existing match in `registry.refreshProviderMeta` — a `local_model = "qwen3"` config
// must match a daemon reporting `qwen3:8b`, or every existing config breaks on upgrade.
function matchesModel(modelNames: readonly string[], modelName: string): boolean {
  return modelNames.some((m) => m === modelName || m.startsWith(`${modelName}:`));
}
