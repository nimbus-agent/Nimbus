import type { NimbusLlmRemoteVendor, NimbusLlmToml } from "../../config/nimbus-toml.ts";
import { AnthropicProvider } from "../../llm/anthropic-provider.ts";
import type { ApiKeyResolver, CloudProviderOptions } from "../../llm/cloud-provider-base.ts";
import { GeminiProvider } from "../../llm/gemini-provider.ts";
import { OpenAiProvider } from "../../llm/openai-provider.ts";
import type { LlmProvider } from "../../llm/types.ts";
import { vendorApiKeyName } from "../../llm/vendor-vault-keys.ts";
import { XaiProvider } from "../../llm/xai-provider.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LLAMACPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/** A minimal logging seam so `buildLlmRegistryFromToml` stays independently callable (the
 *  integration test constructs it with no logger at all) while production wiring passes the real
 *  `syncLogger.warn`, matching the `log: (m) => syncLogger.warn(m)` adapter shape already used
 *  elsewhere in this file. The default is a no-op — production always supplies `syncLogger`
 *  explicitly (see the call in `assemblePlatformServices`), so a dropped-entry warning is never
 *  actually silent at boot; this default only covers callers (e.g. tests) that don't need one. */
export type RouteValidationLogger = { warn: (msg: string) => void };
export const defaultRouteValidationLogger: RouteValidationLogger = { warn: () => {} };

/** Resolves what base URL a `[llm.local.*]` entry actually talks to, applying the runtime's
 *  default when `base_url` is omitted and stripping a trailing slash — the form two entries must
 *  be compared in. Comparing the raw, unresolved field misses the case where BOTH entries omit
 *  `base_url`: both fields are `undefined`, but both resolve to the SAME real endpoint. */
export function resolveBaseUrl(runtime: string, baseUrl: string | undefined): string {
  const explicit = baseUrl?.trim() ?? "";
  if (explicit !== "") return explicit.replace(/\/$/, "");
  return runtime === "llamacpp" ? LLAMACPP_DEFAULT_BASE_URL : OLLAMA_DEFAULT_BASE_URL;
}

export const KNOWN_LOCAL_RUNTIMES = new Set(["ollama", "llamacpp"]);

/** The four cloud vendors this build knows how to CONSTRUCT an adapter for. */
const REMOTE_VENDOR_IDS = ["anthropic", "openai", "gemini", "xai"] as const;
export type RemoteVendorId = (typeof REMOTE_VENDOR_IDS)[number];

function isKnownVendorId(id: string): id is RemoteVendorId {
  return (REMOTE_VENDOR_IDS as readonly string[]).includes(id);
}

export type ResolvedRemoteVendor = {
  vendorId: RemoteVendorId;
  modelName: string;
  apiKey: ApiKeyResolver;
  baseUrl?: string;
};

/**
 * TOTAL over `RemoteVendorId`, so adding a vendor id without adding its factory is a COMPILE
 * ERROR rather than a silent fallthrough — the same shape `EGRESS_BEARING_CLIENT_KINDS` uses to
 * make a new transport a compile error instead of a missing ledger row.
 *
 * This deliberately replaces a `switch` whose `default` would construct one particular vendor: a
 * fifth id added without a case would then be built as THAT vendor's adapter while carrying the
 * new vendor's model name and reading its `<id>.api_key` — prompts posted to the wrong host under
 * a credential minted for someone else. A `default: throw` catches it at runtime; a total map
 * catches it before the code can be committed.
 */
const REMOTE_PROVIDER_FACTORIES: Record<
  RemoteVendorId,
  (opts: CloudProviderOptions) => LlmProvider
> = {
  anthropic: (opts) => new AnthropicProvider(opts),
  openai: (opts) => new OpenAiProvider(opts),
  gemini: (opts) => new GeminiProvider(opts),
  xai: (opts) => new XaiProvider(opts),
};

/** A vendor resolved far enough to construct the Mastra agent: key materialised, not a thunk. */
export type AgentVendor = { providerId: string; modelId: string; apiKey: string };

/**
 * The vendor the Mastra engine agent talks to, or `undefined` when none is enabled AND keyed.
 *
 * `undefined` is the load-bearing case: `gateway-main.ts` then does not construct the agent at
 * all. That matters because `@mastra/core` resolves `ANTHROPIC_API_KEY` from the ENVIRONMENT on
 * its own the moment an agent exists — so "constructed but refusing" would leave a hole exactly
 * the size of the default `nimbus ask`.
 *
 * FIRST enabled-and-keyed vendor in config order. The agent takes one model, unlike the route
 * table which takes all of them; picking the first keeps that deterministic and lets an operator
 * choose by ordering their `[llm.remote.*]` tables.
 *
 * The key is materialised HERE rather than passed as a resolver because Mastra's model config
 * takes a string. The cost is that a key rotated after boot needs a restart FOR THE AGENT —
 * route-table adapters still resolve per call and pick it up immediately.
 */
export async function resolveAgentVendor(
  llmToml: NimbusLlmToml,
  vault: NimbusVault,
  logger: RouteValidationLogger = defaultRouteValidationLogger,
): Promise<AgentVendor | undefined> {
  for (const vendor of resolveEnabledVendors(llmToml.remoteVendors, vault, logger)) {
    const apiKey = await vendor.apiKey();
    if (apiKey !== undefined && apiKey.trim() !== "") {
      return { providerId: vendor.vendorId, modelId: vendor.modelName, apiKey };
    }
  }
  return undefined;
}

export function makeRemoteProvider(v: ResolvedRemoteVendor): LlmProvider {
  return REMOTE_PROVIDER_FACTORIES[v.vendorId]({
    apiKey: v.apiKey,
    modelName: v.modelName,
    ...(v.baseUrl === undefined ? {} : { baseUrl: v.baseUrl }),
  });
}

/**
 * Validates `[llm.remote.*]` AFTER defaults are applied, here rather than in the parser.
 *
 * DO NOT "fix" this by moving it earlier. The instinct is to validate the raw table before
 * defaults so a vendor problem can be isolated — but that moves validation TOWARD the parser, and
 * a throw there is swallowed by `loadTomlSection`'s bare catch, whose outcome is not a dropped
 * vendor but a silently reverted `[llm]` section with `enforce_air_gap` back at `false`.
 * Post-default validation loses nothing, because an absent `enabled` and an explicit
 * `enabled = false` mean the same thing — no field here needs absent-versus-explicit
 * discrimination.
 *
 * Every rejection is warn-logged BY NAME, matching `dropUnknownRuntimeEntries` above. An entry
 * that vanishes without a word is the shape `dropUnresolvableRoutePriorityEntries` refuses to
 * allow.
 */
export function resolveEnabledVendors(
  remoteVendors: ReadonlyMap<string, NimbusLlmRemoteVendor>,
  vault: NimbusVault,
  logger: RouteValidationLogger,
): ResolvedRemoteVendor[] {
  const out: ResolvedRemoteVendor[] = [];
  for (const [vendorId, cfg] of remoteVendors) {
    // Default-off. Not an error and not warned: it is the norm, and the whole point of the
    // per-vendor opt-in.
    if (!cfg.enabled) continue;
    if (!isKnownVendorId(vendorId)) {
      logger.warn(
        `[llm] dropping [llm.remote.${vendorId}]: unknown vendor — expected one of ` +
          REMOTE_VENDOR_IDS.join(", "),
      );
      continue;
    }
    if (cfg.model.trim() === "") {
      logger.warn(`[llm] dropping [llm.remote.${vendorId}]: empty model`);
      continue;
    }
    out.push({
      vendorId,
      modelName: cfg.model,
      // Resolved PER CALL from the Vault, never from the environment: no env var may satisfy a
      // vendor nobody opted into, and a key added after boot works with no restart. `VaultReader`
      // answers `null` for a miss, which is normalised to `undefined` for `ApiKeyResolver`.
      apiKey: async () => (await vault.get(vendorApiKeyName(vendorId))) ?? undefined,
      ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
    });
  }
  return out;
}
