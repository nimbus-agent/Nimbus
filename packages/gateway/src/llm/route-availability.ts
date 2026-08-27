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

/** Default TTL for a cached provider probe result — see `RouteAvailabilityProbe`. */
export const ROUTE_AVAILABILITY_TTL_MS = 30_000;

// What a single `/api/tags`-shaped probe of a provider daemon establishes: whether it
// answered at all, and — only if it did — what models it currently reports. Cached
// per `providerId`, not per route: the model list is a property of the daemon a route's
// provider talks to, not of any one route, so four routes sharing one Ollama daemon
// must cost one round trip, not four.
type ProviderProbeResult = {
  reachable: boolean;
  modelNames: readonly string[];
};

/**
 * Answers "is this route actually usable right now?" — the daemon is reachable AND the
 * route's `modelName` is among the models that daemon currently reports. Deliberately
 * does NOT pull a missing model: falling through to the next configured route is
 * correct; silently starting a multi-gigabyte download because a config entry named a
 * model is not.
 *
 * Caches the per-provider probe (reachability + model list) for `ttlMs`, keyed on
 * `providerId` — long enough that resolving a several-route table over one daemon costs
 * one `/api/tags` call, short enough that a model removed out-of-band (`ollama rm`) is
 * noticed without a restart. `invalidate(providerId)` exists so a successful
 * `LlmRegistry.pullModel` can drop the cache immediately rather than making the caller
 * wait out the TTL to see a model it just pulled.
 */
export class RouteAvailabilityProbe {
  private readonly ttlMs: number;
  private readonly cache = new Map<
    ProviderId,
    { result: Promise<ProviderProbeResult>; expiresAt: number }
  >();

  constructor(ttlMs: number = ROUTE_AVAILABILITY_TTL_MS) {
    this.ttlMs = ttlMs;
  }

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
    this.cache.set(provider.providerId, { result, expiresAt: now + this.ttlMs });
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
