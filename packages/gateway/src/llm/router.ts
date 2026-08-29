import { LlmProviderError } from "./provider-error.ts";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import { makeRouteId } from "./route-id.ts";
import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmProvider,
  LlmTaskType,
  ModelRoute,
  ProviderId,
  ProviderMeta,
} from "./types.ts";

export type { ProviderMeta } from "./types.ts";

export type LlmRouterConfig = {
  preferLocal: boolean;
  localModel: string;
  minReasoningParams: number;
  enforceAirGap: boolean;
  /**
   * An explicit, human-authored ordering of route ids (`"<provider>/<model>"`) to try
   * first, before the normal preferLocal-driven ordering. An entry that no longer
   * resolves to a registered route is skipped. Nothing throws on the way here: config
   * load never rejects a bad entry (a throw in the `[llm]` parser is swallowed by
   * `loadTomlSection`'s bare catch, which would silently revert the WHOLE section,
   * `enforce_air_gap` included), so `platform/assemble.ts` warn-logs and DROPS an
   * unresolvable entry before this config is built, and boot continues. Routes not named
   * here still follow, ordered by `preferLocal` — see `orderedRoutes`.
   */
  readonly routePriority?: readonly string[];
  /**
   * `[llm.tasks]` route pins: for a given task, always try this route id FIRST — ahead of
   * `routePriority` and the `preferLocal` ordering alike. A pin REORDERS candidates; it never
   * exempts one, so `eligibleRoutes`' air-gap exclusion and capability floor still apply to a
   * pinned route exactly as to any other (a pin naming a remote route under `enforce_air_gap`
   * must not resurrect it — that would turn a routing preference into a security hole). A pin
   * naming a route id that is not currently registered, or that resolves but is unavailable,
   * fails OPEN: the walk falls through to normal ordering rather than coming up empty, since a
   * stale pin should degrade to a working answer, not an outage — the pin can only choose among
   * routes that are already registered and already ledgered, so it cannot widen egress.
   *
   * `ReadonlyMap` because `config` is `private readonly` here; the constructor copies this into
   * a private MUTABLE map so a future `setTaskPin(task, routeId)` (runtime re-pinning, e.g. from
   * `nimbus llm use`) can write without touching this immutable config object.
   */
  readonly taskPins?: ReadonlyMap<LlmTaskType, string>;
};

/**
 * The provider `resolveForSynthesis()` selected for an `[agents]` brief synthesis attempt, plus
 * whether it runs on this machine. `isLocal` is derived from the resolved route's
 * `provider.isLocal` — never from `prefersLocal()`/`config.preferLocal`, which express only a
 * preference — so a caller enforcing `[agents].synthesis = "local"` can refuse a resolved remote
 * provider rather than trust config intent.
 */
export type ResolvedSynthesisProvider = {
  readonly providerId: ProviderId;
  readonly modelName: string;
  readonly isLocal: boolean;
};

export type LlmTaskStatus = {
  providerId: ProviderId;
  modelName: string;
  isAvailable: boolean;
  reason: string;
  // Populated only when the preferred provider is unavailable: the provider generate() would
  // actually fall back to, so the status reflects real routing rather than just config intent.
  fallback?: { providerId: ProviderId; modelName: string };
};

const CONTEXT_OVERFLOW_THRESHOLD = 0.85;
const TOKENS_PER_CHAR = 4;

export function midTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  return `${text.slice(0, keep)}\n[...truncated...]\n${text.slice(-keep)}`;
}

// Orders routes local-first or remote-first per `preferLocal`, preserving each half's
// relative (registration) order. Module-level, mirroring `midTruncate` above — no
// per-instance state is involved.
function byPreference(routes: readonly ModelRoute[], preferLocal: boolean): ModelRoute[] {
  const local = routes.filter((r) => r.provider.isLocal);
  const remote = routes.filter((r) => !r.provider.isLocal);
  return preferLocal ? [...local, ...remote] : [...remote, ...local];
}

export class LlmRouter {
  private readonly routeMap = new Map<string, ModelRoute>();
  private readonly config: LlmRouterConfig;
  // A single long-lived probe shared across every walk this router performs, so its
  // per-provider-INSTANCE cache (see `RouteAvailabilityProbe`) actually amortizes repeated
  // checks within the TTL. Injected — not constructed here — so `LlmRegistry` can hold its
  // own reference and `invalidate()` after a successful pull, and so a caller needing
  // different TTLs has a seam rather than `mock.module`.
  private readonly availability: RouteAvailabilityProbe;
  // A private MUTABLE copy of `config.taskPins`, seeded once here. `orderedRoutes` reads THIS
  // map, never `this.config.taskPins` directly, so a future `setTaskPin` can write a runtime pin
  // without needing write access to the immutable `config` field.
  private readonly taskPins: Map<LlmTaskType, string>;

  constructor(
    config: LlmRouterConfig,
    probe: RouteAvailabilityProbe = new RouteAvailabilityProbe(),
  ) {
    this.config = config;
    this.availability = probe;
    this.taskPins = new Map(config.taskPins ?? []);
  }

  registerRoute(provider: LlmProvider, modelName: string, meta: ProviderMeta = {}): void {
    const routeId = makeRouteId(provider.providerId, modelName);
    this.routeMap.set(routeId, { routeId, provider, modelName, meta });
  }

  routes(): readonly ModelRoute[] {
    return [...this.routeMap.values()];
  }

  routeFor(routeId: string): ModelRoute | undefined {
    return this.routeMap.get(routeId);
  }

  /**
   * Re-pins `task` to `routeId` for the lifetime of this router instance (`nimbus llm use`).
   *
   * Writes the private MUTABLE `taskPins` map seeded from `config.taskPins` at construction,
   * never `this.config` itself — `config` is `private readonly` and `taskPins` on it is a
   * `ReadonlyMap`, by design (see the field doc on `LlmRouterConfig.taskPins`): the config
   * object stays an immutable snapshot of what booted, and only the router's own copy moves.
   * Persisting the pin so it survives a restart is the CALLER's job (`ipc/llm-rpc.ts`'s
   * `handleLlmUse` writes `[llm.tasks]` in `nimbus.toml` before calling this) — this method
   * only ever makes the CURRENTLY RUNNING router honour it immediately, without a restart.
   *
   * Deliberately takes `routeId` on faith: `orderedRoutes` already fails open on a pin that
   * does not resolve to a registered route (falls through to normal ordering), so this method
   * does not need its own copy of that check. The caller that DOES need a fail-closed check —
   * "refuse to persist a pin that can never apply" — is `handleLlmUse`, which validates via
   * `routeFor()` before writing anything, deliberately unlike this method and unlike the
   * read-time fail-open above.
   */
  setTaskPin(task: LlmTaskType, routeId: string): void {
    this.taskPins.set(task, routeId);
  }

  prefersLocal(): boolean {
    return this.config.preferLocal;
  }

  /**
   * Whether `[llm] enforce_air_gap` is set.
   *
   * Mirrors {@link prefersLocal}, and the distinction between the two is the whole point:
   * `preferLocal` is a PREFERENCE and is allowed to fall back to a remote provider, while this is
   * a REFUSAL. `selectProvider` already honours it by skipping every non-local provider; this
   * accessor exists so paths that do NOT go through the router — `engine/router.ts`
   * `classifyIntent` is the one that mattered — can be held to the same rule.
   */
  enforcesAirGap(): boolean {
    return this.config.enforceAirGap;
  }

  // `opts.preferLocal` overrides `config.preferLocal` for this call only (e.g. research briefs
  // honoring `[briefs].prefer_local` independently of `[llm].prefer_local` — source text is
  // privacy-sensitive enough to warrant its own knob). Omitted, behavior is unchanged.
  async selectRoute(
    task: LlmTaskType,
    opts?: { preferLocal?: boolean },
  ): Promise<ModelRoute | undefined> {
    return this.firstAvailableRoute(task, (r) => this.probeAvailable(r), opts?.preferLocal);
  }

  async selectProvider(
    task: LlmTaskType,
    opts?: { preferLocal?: boolean },
  ): Promise<LlmProvider | undefined> {
    const route = await this.selectRoute(task, opts);
    return route?.provider;
  }

  /**
   * Resolve the provider a `[agents]` brief synthesis attempt would use, right now, for the
   * `"reasoning"` task — plus an `isLocal` flag read directly off the resolved route's provider
   * instance rather than duplicating the priority walk at the call site. Reuses `selectRoute`, so
   * air-gap and the reasoning capability floor are honored the same way they are for every other
   * caller. Callers that must not trust a bare `remote: true`/`false` re-derive it from
   * `providerId` here, not from `config.preferLocal`.
   *
   * `preferLocal` defaults to `config.preferLocal` — an omitted argument behaves exactly as
   * before this parameter existed. A caller with its own local-preference precedent (mirroring
   * `briefs/brief-llm-adapter.ts`'s `createBriefLlm(router, preferLocal)`) passes its own value
   * instead of inheriting `[llm].prefer_local`: without this, `[llm] prefer_local = false` with a
   * remote provider registered makes priority remote-first, so `resolveForSynthesis()` resolves
   * the remote provider even with a healthy local one — and `[agents] synthesis = "local"` then
   * refuses the whole attempt as `no_eligible_provider`, not because no local provider answered,
   * but because a remote one was picked first.
   */
  async resolveForSynthesis(
    preferLocal: boolean = this.config.preferLocal,
  ): Promise<ResolvedSynthesisProvider | undefined> {
    const route = await this.selectRoute("reasoning", { preferLocal });
    if (route === undefined) {
      return undefined;
    }
    return {
      providerId: route.provider.providerId,
      modelName: route.modelName,
      isLocal: route.provider.isLocal,
    };
  }

  /**
   * Generates markdown from the EXACT route `resolveForSynthesis()` resolved — never
   * re-selects — so the provider actually invoked always matches the one a caller classified as
   * local/remote.
   *
   * `egressMethod` names the `egress_ledger` row this call produces IF the resolved route is
   * non-local; it does NOT decide whether one is written. That is derived from the provider
   * inside `wrapLedgeredProvider` (I29), which `LlmRegistry.addRoute` applied before the route
   * ever entered this table — so a caller that omits the argument still cannot generate
   * unledgered remote egress, it only gets the default `llm.generate.<task>` method name.
   */
  async generateMarkdown(
    prompt: string,
    resolved: ResolvedSynthesisProvider,
    egressMethod?: string,
  ): Promise<string> {
    const route = this.routeFor(makeRouteId(resolved.providerId, resolved.modelName));
    if (route === undefined) {
      throw new Error(`LLM provider "${resolved.providerId}" is no longer registered`);
    }
    const result = await route.provider.generate({
      task: "reasoning",
      prompt,
      // Spread-conditional, not `{ egressMethod }`: under `exactOptionalPropertyTypes` an
      // explicit `egressMethod: undefined` is a different type from an absent key.
      ...(egressMethod === undefined ? {} : { egressMethod }),
    });
    return result.text;
  }

  // Walks the task's route priority order (respecting air-gap and the capability floor) and
  // returns the first route whose provider's availability check resolves true. The check is
  // injected so callers can share a memoized probe across many tasks (see getStatus).
  // `preferLocal`, when provided, overrides `config.preferLocal` for this call only.
  /**
   * Every route passing the task's gates, in priority order — air-gap exclusion FIRST, so a
   * non-local route is never a candidate under `enforce_air_gap` however a consumer walks this.
   *
   * A LAZY generator, deliberately. `generate()` needs to continue past a failed route while
   * `firstAvailableRoute` must stop at the first hit, and returning an array would make the
   * latter probe every remaining route on every call — a real cost, since a local provider's
   * availability probe pays a connection attempt. Laziness lets both share ONE definition of the
   * gates instead of keeping two copies that can drift apart.
   */
  private async *eligibleRoutes(
    task: LlmTaskType,
    isAvailable: (route: ModelRoute) => Promise<boolean>,
    preferLocal?: boolean,
  ): AsyncGenerator<ModelRoute> {
    for (const route of this.orderedRoutes(task, preferLocal)) {
      if (this.config.enforceAirGap && !route.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(route, task)) continue;
      if (await isAvailable(route)) yield route;
    }
  }

  private async firstAvailableRoute(
    task: LlmTaskType,
    isAvailable: (route: ModelRoute) => Promise<boolean>,
    preferLocal?: boolean,
  ): Promise<ModelRoute | undefined> {
    // Pull ONE value from the lazy generator rather than `for await ... return`, which reads as
    // a loop whose body always exits on the first iteration — correct, but a static analyser
    // flags it and a reader has to prove it. Taking the iterator explicitly says "the first
    // eligible route" outright, and `return()` releases the generator so the routes behind it are
    // never probed.
    const routes = this.eligibleRoutes(task, isAvailable, preferLocal);
    const first = await routes.next();
    await routes.return(undefined);
    return first.done === true ? undefined : first.value;
  }

  // Orders every registered route for a task: this.taskPins' entry for `task` first (if it
  // resolves to a registered route), then `config.routePriority` entries (in the order given,
  // skipping any that no longer resolve to a registered route), then everything else ordered by
  // `preferLocal`. The pin is applied as a reorder over the fully-computed base ordering — never
  // a separate "insert unconditionally" branch — so a pin can promote a route already present in
  // routePriority or the preferLocal tail without duplicating it, and so it never adds a route
  // this task's caller has not already deemed eligible; `eligibleRoutes` filters (air-gap,
  // capability floor, availability) are applied to the RESULT of this ordering, unchanged.
  private orderedRoutes(
    task: LlmTaskType,
    preferLocal: boolean = this.config.preferLocal,
  ): ModelRoute[] {
    const base = this.baseOrderedRoutes(preferLocal);
    const pinnedRouteId = this.taskPins.get(task);
    if (pinnedRouteId === undefined) return base;
    const pinnedIndex = base.findIndex((r) => r.routeId === pinnedRouteId);
    // -1 (not registered / not in this ordering at all) and 0 (already first) both need no
    // change — fail OPEN on the former by returning the untouched normal ordering, deliberately:
    // a stale pin degrades to a working answer rather than an outage, and this method has no way
    // to know here whether "not found" means unregistered or excluded by a filter applied later.
    if (pinnedIndex <= 0) return base;
    const pinned = base[pinnedIndex];
    if (pinned === undefined) return base; // unreachable given the bounds check above; type-narrowing only
    return [pinned, ...base.slice(0, pinnedIndex), ...base.slice(pinnedIndex + 1)];
  }

  private baseOrderedRoutes(preferLocal: boolean): ModelRoute[] {
    const all = this.routes();
    const explicit = this.config.routePriority;
    if (explicit !== undefined && explicit.length > 0) {
      const byId = new Map(all.map((r) => [r.routeId, r]));
      // Nothing throws for an unresolvable entry: `platform/assemble.ts` already warn-logged
      // and dropped it (by name) before this router was constructed. Anything still missing
      // here was unregistered at runtime, so skipping is correct.
      const ordered = explicit
        .map((id) => byId.get(id))
        .filter((r): r is ModelRoute => r !== undefined);
      const named = new Set(ordered.map((r) => r.routeId));
      // The unnamed tail still honours preferLocal. Leaving it in registration order
      // would make the fallback order depend on config-file ordering, which is
      // arbitrary — and would quietly ignore prefer_local for exactly the routes the
      // user did not think to rank. Appending them at all (rather than dropping) is
      // deliberate: a route added to [llm.local.*] but forgotten in route_priority
      // should still be reachable, not invisible.
      return [
        ...ordered,
        ...byPreference(
          all.filter((r) => !named.has(r.routeId)),
          preferLocal,
        ),
      ];
    }
    return byPreference(all, preferLocal);
  }

  // Route-level availability: the daemon is reachable AND `route.modelName` is among the
  // models it currently reports (via the shared `RouteAvailabilityProbe`) — not just
  // "the daemon answered". `RouteAvailabilityProbe.check` already catches internally,
  // so this catch is defense-in-depth, preserving the pre-existing catch-to-false.
  private async probeAvailable(route: ModelRoute): Promise<boolean> {
    try {
      return (await this.availability.check(route)).available;
    } catch {
      return false; // treat availability check failure as unavailable
    }
  }

  /**
   * Walks the task's priority order, trying each eligible route until one answers.
   *
   * This used to resolve ONE route and call it, with no try/catch — tolerable while every route
   * was local, because the availability probe genuinely predicted reachability. Cloud adapters
   * answer availability OFFLINE (slice 2b §7.4), so a remote route reports available whatever the
   * network is doing, and a single-shot call would turn "no internet" into a hard failure even
   * with a healthy local model next in line. The roadmap row this serves promises local FALLBACK.
   *
   * The retry rule is deliberately NARROW: only a TRANSPORT-class failure continues the walk. An
   * auth- or request-class failure fails identically at the next vendor, so retrying would send
   * the same prompt to a second destination — one more real outbound request and one more
   * `egress_ledger` row — for no better answer. An error with NO classification is treated as
   * non-retryable for the same reason: retrying is the action that costs egress, so it is what has
   * to be earned.
   *
   * ONE PROMPT CAN PRODUCE N LEDGER ROWS across N destinations, and that is CORRECT — each row
   * records a real outbound request. Do not "deduplicate" them; a ledger that collapsed them would
   * under-report egress. They appear naturally, one per attempt, because each attempt goes through
   * its own wrapped provider.
   */
  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    let lastError: unknown;
    // Route ids already INVOKED, not merely visited. `fitPromptOrFallback` can redirect an
    // overflowing prompt onto a DIFFERENT route than the one the walk is currently on, and that
    // route is still ahead in the walk — so without this the same destination is called twice for
    // one prompt: two real outbound requests and two `egress_ledger` rows, the second buying
    // nothing. The rule above earns one row per DISTINCT destination attempted; this keeps that
    // true.
    const attempted = new Set<string>();

    for await (const route of this.eligibleRoutes(opts.task, (r) => this.probeAvailable(r))) {
      const adjusted = await this.fitPromptOrFallback(opts, route);
      const target = adjusted.kind === "route" ? adjusted.route : route;
      if (attempted.has(target.routeId)) continue;
      attempted.add(target.routeId);
      try {
        return await target.provider.generate(adjusted.opts);
      } catch (err) {
        lastError = err;
        if (err instanceof LlmProviderError && err.kind === "transport") {
          continue; // Try the next destination.
        }
        throw err; // Auth, request, or unclassified: the next vendor cannot do better.
      }
    }

    // `attempted.size`, not a visited flag: a walk whose every candidate was already invoked via
    // a fallback redirect has still tried something, and must report THAT failure rather than the
    // misleading "no provider available".
    if (attempted.size === 0) {
      throw new Error(`No LLM provider available for task: ${opts.task}`);
    }
    throw lastError;
  }

  private async fitPromptOrFallback(
    opts: LlmGenerateOptions,
    route: ModelRoute,
  ): Promise<
    | { kind: "opts"; opts: LlmGenerateOptions }
    | { kind: "route"; route: ModelRoute; opts: LlmGenerateOptions }
  > {
    const contextWindow = route.meta.contextWindow;
    if (contextWindow === undefined) {
      return { kind: "opts", opts };
    }
    const estimatedTokens = Math.ceil(opts.prompt.length / TOKENS_PER_CHAR);
    const tokenLimit = Math.floor(contextWindow * CONTEXT_OVERFLOW_THRESHOLD);
    if (estimatedTokens <= tokenLimit) {
      return { kind: "opts", opts };
    }
    const truncated = {
      ...opts,
      prompt: midTruncate(opts.prompt, tokenLimit * TOKENS_PER_CHAR),
    };
    if (opts.task === "summarisation" || opts.task === "classification") {
      return { kind: "opts", opts: truncated };
    }
    // Defensive, not reachable through the public `generate()` path today: `selectRoute`
    // already excludes non-local routes when air-gap is enforced (I6-adjacent posture), so
    // `route` here is always local under air-gap. Kept because truncating a NON-local route's
    // prompt would not fix the actual problem — the prompt would still leave the machine — so
    // truncation is not an acceptable substitute for refusal in that case. A local overflowing
    // route with no fitting fallback truncates instead (below), which the "local" half of this
    // condition permits.
    if (this.config.enforceAirGap && !route.provider.isLocal) {
      throw new Error(
        `Prompt exceeds provider context window and air-gap mode prevents remote fallback`,
      );
    }
    const fallback = await this.findFallbackRoute(opts.task, estimatedTokens);
    if (fallback !== undefined) {
      return { kind: "route", route: fallback, opts };
    }
    return { kind: "opts", opts: truncated };
  }

  // Walks routes in priority order looking for the next one the overflowing prompt actually
  // fits in — replaces the old literal `providerFor("remote")` lookup. Applies the SAME gates
  // as `firstAvailableRoute` (air-gap, capability floor, availability), evaluated per candidate
  // rather than against a pre-filtered pool, plus a context-fit check using the same threshold
  // math as the overflow check above. A route with no declared `contextWindow` is eligible
  // (fail-open, matching `meetsCapabilityFloor`'s treatment of an undisclosed `parameterCount`).
  // The originally overflowing route is never explicitly excluded — it fails its own fit check
  // here for the same reason it overflowed above, since both use the same threshold formula.
  private async findFallbackRoute(
    task: LlmTaskType,
    estimatedTokens: number,
  ): Promise<ModelRoute | undefined> {
    for (const candidate of this.orderedRoutes(task)) {
      if (this.config.enforceAirGap && !candidate.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(candidate, task)) continue;
      const window = candidate.meta.contextWindow;
      if (window !== undefined) {
        const limit = Math.floor(window * CONTEXT_OVERFLOW_THRESHOLD);
        if (estimatedTokens > limit) continue;
      }
      if (await this.probeAvailable(candidate)) return candidate;
    }
    return undefined;
  }

  private meetsCapabilityFloor(route: ModelRoute, task: LlmTaskType): boolean {
    if (task !== "reasoning" && task !== "agent_step") return true;
    if (route.meta.parameterCount === undefined) return true;
    return route.meta.parameterCount >= this.config.minReasoningParams;
  }

  private reasonFor(task: LlmTaskType, route: ModelRoute): string {
    const isLocal = route.provider.isLocal;
    if (this.config.enforceAirGap && isLocal) return "air-gap";
    // A task pin can select a route the preferLocal branches below would otherwise mis-explain:
    // e.g. `preferLocal: false` with a pin naming a LOCAL route falls through to
    // "no-remote-provider" below, which is false — a remote route IS registered, it is simply
    // outranked by the pin — and the mirror case (`preferLocal: true`, a remote pin) falls
    // through to "no-local-provider"/"local-below-reasoning-floor", equally false. Checked
    // before every preferLocal-derived branch so the pin, when it is the actual reason this
    // route won, always wins over a guess based on `preferLocal` alone.
    if (this.taskPins.get(task) === route.routeId) return "task-pin";
    if (this.config.preferLocal && isLocal) return "prefer-local";
    if (!this.config.preferLocal && !isLocal) return "prefer-remote";
    // The preferred provider does not match the configured preference.
    if (this.config.preferLocal && !isLocal) {
      // A local provider may be registered but skipped because it falls below the reasoning
      // capability floor — distinguish that from "no local provider registered at all".
      return this.localProviderBelowFloor(task)
        ? "local-below-reasoning-floor"
        : "no-local-provider";
    }
    return "no-remote-provider";
  }

  // True when a local route is registered for this task but was excluded by the reasoning
  // capability floor (only reasoning/agent_step carry a floor).
  private localProviderBelowFloor(task: LlmTaskType): boolean {
    for (const route of this.routes()) {
      if (!route.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(route, task)) return true;
    }
    return false;
  }

  // Finds the highest-priority route for a task based on config (priority order, capability
  // floor, air-gap) WITHOUT calling isAvailable(). Used by getStatus() so that the status entry
  // reflects config intent; isAvailable() is then probed separately.
  private findPreferredRoute(task: LlmTaskType): ModelRoute | undefined {
    for (const route of this.orderedRoutes(task)) {
      if (this.config.enforceAirGap && !route.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(route, task)) continue;
      return route;
    }
    return undefined;
  }

  async getStatus(): Promise<Record<LlmTaskType, LlmTaskStatus | undefined>> {
    const tasks: LlmTaskType[] = ["classification", "reasoning", "summarisation", "agent_step"];
    const out: Partial<Record<LlmTaskType, LlmTaskStatus | undefined>> = {};
    // `probeAvailable` already goes through the shared `this.availability` probe, whose
    // own per-provider-instance TTL cache amortizes repeated checks — a second, per-call
    // cache here (as this used to have) is redundant, and two caching layers with different
    // lifetimes over the same question is how they drift apart.
    const isAvailable = (route: ModelRoute): Promise<boolean> => this.probeAvailable(route);
    for (const t of tasks) {
      const preferred = this.findPreferredRoute(t);
      if (preferred === undefined) {
        out[t] = undefined;
        continue;
      }
      const preferredAvailable = await isAvailable(preferred);
      const entry: LlmTaskStatus = {
        providerId: preferred.provider.providerId,
        modelName: preferred.modelName,
        isAvailable: preferredAvailable,
        reason: this.reasonFor(t, preferred),
      };
      if (!preferredAvailable) {
        // The preferred provider is down; report the route generate() would actually fall
        // back to (next available in priority order) so status matches real routing.
        const actual = await this.firstAvailableRoute(t, isAvailable);
        // Compared by ROUTE id, not provider id. Two routes on one provider is the normal case
        // now that `(provider, model)` is the key — `ollama/qwen3:8b` down and
        // `ollama/gemma3:12b` answering in its place is precisely the fallback a user needs to
        // see, and a providerId comparison suppressed it as "same provider, nothing to report".
        // A route can only equal itself here, so the self-suppression this guard exists for
        // still holds.
        if (actual !== undefined && actual.routeId !== preferred.routeId) {
          entry.fallback = {
            providerId: actual.provider.providerId,
            modelName: actual.modelName,
          };
        }
      }
      out[t] = entry;
    }
    return out as Record<LlmTaskType, LlmTaskStatus | undefined>;
  }
}
