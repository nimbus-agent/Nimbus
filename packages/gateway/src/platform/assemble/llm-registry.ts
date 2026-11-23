import type { Database } from "bun:sqlite";
import {
  DEFAULT_NIMBUS_LLM_TOML,
  loadNimbusLlmFromConfigDir,
  type NimbusLlmLocalRoute,
  type NimbusLlmToml,
} from "../../config/nimbus-toml.ts";
import { isLoopbackBaseUrl } from "../../llm/base-url-locality.ts";
import { LlamaCppProvider } from "../../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../../llm/ollama-provider.ts";
import { LlmRegistry } from "../../llm/registry.ts";
import { makeRouteId, parseRouteRef } from "../../llm/route-id.ts";
import { vendorApiKeyName } from "../../llm/vendor-vault-keys.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  defaultRouteValidationLogger,
  KNOWN_LOCAL_RUNTIMES,
  makeRemoteProvider,
  OLLAMA_DEFAULT_BASE_URL,
  type ResolvedRemoteVendor,
  type RouteValidationLogger,
  resolveBaseUrl,
  resolveEnabledVendors,
} from "./llm-vendors.ts";

/**
 * Drops (and names, via `logger.warn`) any `[llm.local.*]` entry whose `runtime` is neither
 * `"ollama"` nor `"llamacpp"` — the only two runtimes this build knows how to construct a
 * provider for. `NimbusLlmLocalRoute.runtime` is an intentionally open string at the parser layer
 * (Task 8), so a typo or a not-yet-supported runtime (e.g. `"vllm"`) must not silently fall
 * through to the `runtime === "llamacpp" ? llamacpp : ollama` branches below and get constructed
 * as an Ollama route pointed at a port that entry never asked for.
 */
function dropUnknownRuntimeEntries(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  for (const [name, route] of localRoutes) {
    if (!KNOWN_LOCAL_RUNTIMES.has(route.runtime)) {
      logger.warn(
        `[llm] dropping [llm.local.${name}]: unknown runtime "${route.runtime}" — expected ` +
          '"ollama" or "llamacpp"',
      );
      continue;
    }
    kept.set(name, route);
  }
  return kept;
}

/**
 * Task 9's validation stage — deliberately NOT in the Task 8 parser, because a throw there is
 * swallowed by `loadTomlSection`'s bare catch and silently reverts the WHOLE `[llm]` section to
 * defaults (including `enforce_air_gap`). Here a bad entry is logged and dropped; nothing else in
 * `[llm]` is affected.
 *
 * Only a `llamacpp` base URL claimed twice is an error: `LlamaCppProvider.generate()` sends no
 * model field, so the server answers with whatever weights it was launched with — two llama.cpp
 * routes at one URL would report two different model names against IDENTICAL weights, a route
 * table that lies. Ollama is exempt: `generate()` sends `this.modelName` per request to a shared
 * daemon, so many routes at one base URL is the normal, correct case.
 *
 * First occurrence (file order — `localRoutes` preserves it) wins; every later collider is
 * dropped and logged by name.
 */
function dropLlamacppBaseUrlCollisions(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  const claimedBy = new Map<string, string>(); // resolved llamacpp base URL -> first entry name
  for (const [name, route] of localRoutes) {
    if (route.runtime === "llamacpp") {
      const resolved = resolveBaseUrl(route.runtime, route.baseUrl);
      const existing = claimedBy.get(resolved);
      if (existing !== undefined) {
        logger.warn(
          `[llm] dropping [llm.local.${name}]: llamacpp base URL "${resolved}" is already ` +
            `claimed by [llm.local.${existing}] — a llama.cpp server reports one model for the ` +
            "whole process, so two routes at the same URL would report different model names " +
            "against identical weights",
        );
        continue;
      }
      claimedBy.set(resolved, name);
    }
    kept.set(name, route);
  }
  return kept;
}

/**
 * Drops (and names) any `[llm.local.*]` entry whose derived route id — `<runtime>/<model>` — was
 * already claimed by an earlier entry. `LlmRouter.registerRoute` keys on that id and uses
 * `Map.set`, so without this stage a second entry naming the same runtime AND model at a
 * different `base_url` (a plausible failover pairing: the same model on a laptop and on a
 * workstation) silently REPLACES the first, and `nimbus llm status` shows one row pointing at the
 * second URL with nothing to explain where the other went.
 *
 * FIRST occurrence wins, matching `dropLlamacppBaseUrlCollisions` above — the two drop rules must
 * not disagree about which entry survives, or which one you get depends on which check fired.
 * Every other drop path in this slice names the offending entry; a route that vanishes without a
 * word is the exact shape `dropUnresolvableRoutePriorityEntries` refuses to allow.
 */
function dropDuplicateRouteIds(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): Map<string, NimbusLlmLocalRoute> {
  const kept = new Map<string, NimbusLlmLocalRoute>();
  const claimedBy = new Map<string, string>(); // route id -> first entry name
  for (const [name, route] of localRoutes) {
    const routeId = makeRouteId(route.runtime === "llamacpp" ? "llamacpp" : "ollama", route.model);
    const existing = claimedBy.get(routeId);
    if (existing !== undefined) {
      logger.warn(
        `[llm] dropping [llm.local.${name}]: route id "${routeId}" is already claimed by ` +
          `[llm.local.${existing}] — a route is keyed on (runtime, model), so two entries ` +
          "naming the same pair are one route; keeping the first, and the later entry's " +
          "base_url is NOT used",
      );
      continue;
    }
    claimedBy.set(routeId, name);
    kept.set(name, route);
  }
  return kept;
}

/**
 * Names — in the boot log, by entry name — every `[llm.local.*]` entry whose resolved base URL is
 * NOT loopback, and is therefore registered as a REMOTE route.
 *
 * Nothing is dropped here. The reclassification itself happens in the provider constructors
 * (`OllamaProvider`/`LlamaCppProvider` derive `isLocal` from the resolved base URL — see
 * `llm/base-url-locality.ts`), which is what actually stops `[llm] enforce_air_gap` from treating
 * a LAN daemon as air-gap-eligible. This stage exists so the reclassification is never SILENT: a
 * route configured under a heading that reads `[llm.local.ws]` and then excluded by air-gap, or
 * ledgered as egress, would otherwise be inexplicable from the user's seat.
 *
 * Dropping instead of warning was the other option and is wrong: a deliberately-configured LAN
 * llama.cpp box is a legitimate setup, and it stays usable with air-gap off. What must not happen
 * is it counting as local.
 */
function warnRemoteClassifiedLocalRoutes(
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  logger: RouteValidationLogger,
): void {
  for (const [name, route] of localRoutes) {
    const resolved = resolveBaseUrl(route.runtime, route.baseUrl);
    if (isLoopbackBaseUrl(resolved)) continue;
    logger.warn(
      `[llm] [llm.local.${name}] base URL "${resolved}" is not loopback — registering it as a ` +
        "REMOTE route: prompts sent to it leave this machine, so it is excluded when " +
        "[llm] enforce_air_gap is set and its use is recorded in the egress ledger",
    );
  }
}

/**
 * Resolves `[llm] route_priority` entries against the route ids that are ACTUALLY about to be
 * registered, dropping (with a named log line) any entry that fails `parseRouteRef` or names no
 * registered route. Silence is not acceptable here: a vanished priority entry changes which model
 * answers with no outward sign.
 *
 * LIMITATION (stated, not papered over): a malformed `route_priority` VALUE — e.g.
 * `route_priority = "ollama"`, a string rather than an array — is swallowed by
 * `parseNimbusTomlLlmSection` (Task 8) with no diagnostic, and arrives here as simply unset. This
 * function only ever sees entries that PARSED as an array of strings, so it cannot distinguish
 * "not configured" from "malformed", and cannot name that entry — it validates only well-formed
 * strings that fail `parseRouteRef` or resolve to no registered route.
 */
function dropUnresolvableRoutePriorityEntries(
  routePriority: readonly string[],
  registeredRouteIds: ReadonlySet<string>,
  logger: RouteValidationLogger,
): string[] {
  const kept: string[] = [];
  for (const entry of routePriority) {
    let parsed: { providerId: string; modelName: string };
    try {
      parsed = parseRouteRef(entry);
    } catch (err) {
      logger.warn(
        `[llm] dropping route_priority entry "${entry}": malformed — ${String(err instanceof Error ? err.message : err)}`,
      );
      continue;
    }
    const routeId = makeRouteId(parsed.providerId, parsed.modelName);
    if (!registeredRouteIds.has(routeId)) {
      logger.warn(
        `[llm] dropping route_priority entry "${entry}": does not name a registered route`,
      );
      continue;
    }
    kept.push(routeId);
  }
  return kept;
}

/** Load the [llm] config from the active TOML, apply the model overrides, and build the provider
 *  registry — one route per `[llm.local.<name>]` entry when any are configured, else today's two
 *  built-in Ollama + llama.cpp providers (unchanged behaviour). Also runs the validation Task 8
 *  deliberately does not: dropping (never aborting boot on) a duplicate llamacpp base URL or an
 *  unresolvable `route_priority` entry. `logger` defaults to a no-op so this stays independently
 *  callable (e.g. from a test) without a real Gateway logger; production wiring always supplies
 *  `syncLogger`, so a dropped-entry warning is never actually silent at boot. */
export async function buildLlmRegistryFromToml(
  db: Database,
  configDir: string,
  vault: NimbusVault,
  logger: RouteValidationLogger = defaultRouteValidationLogger,
): Promise<LlmRegistry> {
  const llmToml = loadNimbusLlmFromConfigDir(configDir);
  const knownRuntimeLocalRoutes = dropUnknownRuntimeEntries(llmToml.localRoutes, logger);
  const uncollidedLocalRoutes = dropLlamacppBaseUrlCollisions(knownRuntimeLocalRoutes, logger);
  const validatedLocalRoutes = dropDuplicateRouteIds(uncollidedLocalRoutes, logger);
  warnRemoteClassifiedLocalRoutes(validatedLocalRoutes, logger);

  // `local_model = ""` parses to the empty string and survives `loadNimbusLlmFromConfigDir` (the
  // `[llm]` parser assigns `parseString(valRaw)` unconditionally). It then reaches
  // `makeRouteId`, which THROWS on an empty model name — and this function is called from
  // `assemblePlatformServices` with nothing between it and boot, so a one-character config typo
  // took the whole Gateway down with `modelName must not be empty`. Nothing in assembly may
  // abort boot: keep the shipped default and say so by name.
  const localModel = llmToml.localModel.trim();
  const effectiveLocalModel =
    localModel === "" ? DEFAULT_NIMBUS_LLM_TOML.localModel : llmToml.localModel;
  if (localModel === "") {
    logger.warn(
      `[llm] local_model is empty — keeping the default "${DEFAULT_NIMBUS_LLM_TOML.localModel}"; ` +
        "an empty model name cannot name a route",
    );
  }

  // The route ids that WILL be registered below — computed up front (without touching the
  // registry) so route_priority can be validated against the real, post-collision-check set
  // before the router is constructed, since `LlmRouterConfig.routePriority` is set at
  // construction time.
  const localRouteIdsToRegister: string[] =
    validatedLocalRoutes.size > 0
      ? [...validatedLocalRoutes.values()].map((route) =>
          makeRouteId(route.runtime === "llamacpp" ? "llamacpp" : "ollama", route.model),
        )
      : [makeRouteId("ollama", effectiveLocalModel), makeRouteId("llamacpp", effectiveLocalModel)];

  // REMOTE route ids belong in this set too, and leaving them out was a real bug: the vendor
  // loop registers them AFTER the router is constructed, but `routePriority` is frozen into
  // `LlmRouterConfig` at construction — so a `[llm.remote.*]` id named in `route_priority` was
  // dropped as "does not name a registered route" and could never be honoured. With
  // `prefer_local = true` that left an enabled cloud vendor effectively unreachable, since
  // `byPreference` always put the local routes first.
  //
  // Keyless vendors are INCLUDED here on purpose. Whether a key resolves is not known until the
  // async registration loop below, and over-including is safe: `orderedRoutes` skips an id that
  // did not end up registered, and the vendor loop warns by name when it drops one. Excluding
  // them would resurrect this bug for anyone whose key arrives after boot.
  // Resolved ONCE and reused by the registration loop below: `resolveEnabledVendors` warns by
  // name for an unknown vendor or an empty model, so calling it twice would emit every warning
  // twice.
  const enabledVendors = resolveEnabledVendors(llmToml.remoteVendors, vault, logger);
  const remoteRouteIdsToRegister: string[] = enabledVendors.map((v) =>
    makeRouteId(v.vendorId, v.modelName),
  );

  const routeIdsToRegister: string[] = [...localRouteIdsToRegister, ...remoteRouteIdsToRegister];

  const validatedRoutePriority = dropUnresolvableRoutePriorityEntries(
    llmToml.routePriority,
    new Set(routeIdsToRegister),
    logger,
  );

  const llmRegistry = new LlmRegistry({
    db,
    config: {
      preferLocal: llmToml.preferLocal,
      localModel: effectiveLocalModel,
      minReasoningParams: llmToml.minReasoningParams,
      enforceAirGap: llmToml.enforceAirGap,
      routePriority: validatedRoutePriority,
      // Unlike `routePriority`, an unresolvable entry is NOT dropped here: the router's own
      // `orderedRoutes` already fails open on a pin naming an unregistered or unavailable route
      // (falls through to normal ordering, never comes up empty), so pre-validating against
      // `routeIdsToRegister` would only duplicate that behaviour with a warn-log for a case that
      // is expected to happen routinely (a pinned local model that has not been pulled yet, or a
      // pinned vendor route that is momentarily down).
      //
      // Spread-conditional, not `taskPins: llmToml.taskPins`: under `exactOptionalPropertyTypes`
      // an explicit `taskPins: undefined` is a different type from an absent key.
      ...(llmToml.taskPins === undefined ? {} : { taskPins: llmToml.taskPins }),
    },
  });

  registerLocalRoutes(llmRegistry, validatedLocalRoutes, {
    llmToml,
    effectiveLocalModel,
    logger,
  });
  await registerRemoteVendorRoutes(llmRegistry, enabledVendors, logger);

  // Fill in `parameterCount` so `[llm] min_reasoning_params` can fire at all (F8). Fire-and-
  // forget: nothing downstream blocks on it, and a provider that is down simply leaves the floor
  // fail-open exactly as it was. Called with NO argument — one pass over every registered local
  // route, each matched against its OWN `route.modelName` inside `refreshProviderMeta` — never a
  // single shared name looped across all routes (Task 9 review, finding 1: that shape cross-
  // assigned one route's parameterCount onto another route sharing the same daemon). One
  // `listModels()` call per local route, not per route × distinct model name.
  void llmRegistry.refreshProviderMeta();
  return llmRegistry;
}

/**
 * Register the LOCAL routes: one per `[llm.local.<name>]` entry when any survived validation,
 * else the two built-in Ollama + llama.cpp providers on the effective local model.
 *
 * Split out of `buildLlmRegistryFromToml` so the two shapes sit side by side instead of as an
 * if/else the length of the function that contains them.
 */
function registerLocalRoutes(
  llmRegistry: LlmRegistry,
  validatedLocalRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>,
  ctx: {
    llmToml: NimbusLlmToml;
    effectiveLocalModel: string;
    logger: RouteValidationLogger;
  },
): void {
  const { llmToml, effectiveLocalModel, logger } = ctx;
  if (validatedLocalRoutes.size > 0) {
    for (const route of validatedLocalRoutes.values()) {
      const baseUrl = resolveBaseUrl(route.runtime, route.baseUrl);
      const provider =
        route.runtime === "llamacpp"
          ? new LlamaCppProvider(baseUrl, route.model)
          : new OllamaProvider(baseUrl, route.model, llmToml.localContextTokens);
      llmRegistry.addRoute(provider, route.model);
    }
    return;
  }

  llmRegistry.addRoute(
    new OllamaProvider(OLLAMA_DEFAULT_BASE_URL, effectiveLocalModel, llmToml.localContextTokens),
    effectiveLocalModel,
  );
  const llamacppBaseUrl = llmToml.llamacppServerPath.trim();
  // The legacy single-route path reaches the same hazard through a different key: an
  // `[llm] llamacpp_server_path` pointed at a LAN box also produces a non-local provider now,
  // and that must be as visible here as it is for a `[llm.local.*]` entry.
  if (llamacppBaseUrl !== "" && !isLoopbackBaseUrl(llamacppBaseUrl)) {
    logger.warn(
      `[llm] llamacpp_server_path "${llamacppBaseUrl}" is not loopback — registering the ` +
        "llama.cpp route as REMOTE: it is excluded when [llm] enforce_air_gap is set",
    );
  }
  llmRegistry.addRoute(
    new LlamaCppProvider(llamacppBaseUrl === "" ? undefined : llamacppBaseUrl, effectiveLocalModel),
    effectiveLocalModel,
  );
}

/**
 * Register the enabled `[llm.remote.<vendor>]` routes.
 *
 * Registering a vendor HERE is what turns I29's `model` egress class from wired-but-zero-row into
 * a live one: `addRoute` passes every non-local provider through `wrapLedgeredProvider` (slice
 * 2a), so each of these routes ledgers before every generate without the adapter cooperating. A
 * vendor that is enabled but whose key does not resolve is DROPPED with a warning rather than
 * registered, so a keyless route never enters the priority walk at all.
 */
async function registerRemoteVendorRoutes(
  llmRegistry: LlmRegistry,
  enabledVendors: readonly ResolvedRemoteVendor[],
  logger: RouteValidationLogger,
): Promise<void> {
  // Every vendor's key is read at once (Vault READS may overlap; only writes touch the macOS key
  // index), and the results are then handled strictly in config order: registration order is route
  // order for `byPreference`, and a failed read still rejects at the vendor where a one-at-a-time
  // loop would have stopped, after the same warnings and registrations for every vendor before it.
  const keyReads = await Promise.allSettled(enabledVendors.map((vendor) => vendor.apiKey()));
  for (const [i, vendor] of enabledVendors.entries()) {
    const read = keyReads[i];
    if (read?.status === "rejected") throw read.reason;
    const key = read?.value;
    if (key === undefined || key.trim() === "") {
      logger.warn(
        `[llm] dropping [llm.remote.${vendor.vendorId}]: enabled but no ` +
          `${vendorApiKeyName(vendor.vendorId)} in the Vault`,
      );
      continue;
    }
    llmRegistry.addRoute(makeRemoteProvider(vendor), vendor.modelName);
  }
}
