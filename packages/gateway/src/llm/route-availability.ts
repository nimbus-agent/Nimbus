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
  /**
   * `not_configured` is REMOTE-ONLY: a cloud route that is enabled but has no resolvable key.
   * It exists because three different fixes otherwise collapse into one word — start the daemon
   * (`provider_unreachable`), pull the model (`model_absent`), add a key. A cloud adapter answers
   * `isAvailable()` OFFLINE, so a `false` from one means "no key" and never "unreachable"; that
   * is what makes the distinction derivable here without issuing a probe.
   */
  reason: "ok" | "provider_unreachable" | "model_absent" | "not_configured";
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
// answered at all, and — only if it did — what models it currently reports. Cached per
// provider INSTANCE, not per route and NOT per `providerId`: the model list is a property
// of the one daemon a route's provider talks to, so four routes sharing one Ollama
// provider instance must cost one round trip, not four — while two `[llm.local.*]` entries
// pointed at DIFFERENT Ollama daemons (`assemble.ts` constructs one `OllamaProvider` per
// entry, and ollama is exempt from the base-url collision rule) must each be probed
// against their own daemon. Keying on `providerId` would answer the second daemon's route
// from the first daemon's model list, reopening exactly the fail-open §3.4 exists to close.
// Mirrors `registry.ts` `listAllModels`, which dedups by instance for the same reason.
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
 * Caches the probe (reachability + model list) keyed on the provider INSTANCE, for
 * `positiveTtlMs` when the daemon answered or `negativeTtlMs` when it didn't — see the
 * two constants above for why they differ. `invalidate(providerId)` exists so a
 * successful `LlmRegistry.pullModel` can drop the cache immediately rather than making
 * the caller wait out the TTL to see a model it just pulled; it still takes a vendor id
 * (that is all `pullModel` has) and clears every cached instance carrying that id.
 */
export class RouteAvailabilityProbe {
  private readonly cache = new Map<LlmProvider, CacheEntry>();

  constructor(
    private readonly positiveTtlMs: number = ROUTE_AVAILABILITY_POSITIVE_TTL_MS,
    private readonly negativeTtlMs: number = ROUTE_AVAILABILITY_NEGATIVE_TTL_MS,
  ) {}

  async check(route: ModelRoute): Promise<RouteAvailability> {
    const probe = await this.probeProvider(route.provider);
    if (!probe.reachable) {
      // Split on LOCALITY. A remote adapter's `isAvailable()` is offline and answers exactly
      // "enabled and keyed", so a `false` from one means the credential is missing — not that
      // anything was unreachable, and telling the user to check their network for a missing key
      // would send them to the wrong remedy.
      return {
        available: false,
        reason: route.provider.isLocal ? "provider_unreachable" : "not_configured",
      };
    }
    if (matchesModel(probe.modelNames, route.modelName)) {
      return { available: true, reason: "ok" };
    }
    return { available: false, reason: "model_absent" };
  }

  /**
   * Drops every cached probe belonging to a provider whose vendor id is `providerId`, so
   * the next `check()` on any of them re-lists. Iterates rather than deleting one key
   * because the cache is keyed on the provider INSTANCE: one vendor id can have several
   * instances (several Ollama daemons), and a pull against that vendor invalidates what
   * we believe about all of them — dropping too much only costs a re-list, whereas
   * dropping too little leaves a just-pulled model reading as absent.
   */
  invalidate(providerId: ProviderId): void {
    for (const provider of [...this.cache.keys()]) {
      if (provider.providerId === providerId) this.cache.delete(provider);
    }
  }

  private probeProvider(provider: LlmProvider): Promise<ProviderProbeResult> {
    const now = Date.now();
    const cached = this.cache.get(provider);
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
    this.cache.set(provider, entry);
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
