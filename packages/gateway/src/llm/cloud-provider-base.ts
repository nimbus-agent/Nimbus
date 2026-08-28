// packages/gateway/src/llm/cloud-provider-base.ts

import { LlmProviderError } from "./provider-error.ts";
import type { LlmModelInfo } from "./types.ts";

/**
 * Resolves the vendor key, PER CALL, from the Vault.
 *
 * NEVER from the environment: an env var must not be able to satisfy a vendor nobody opted into,
 * which is the hole the per-vendor `[llm.remote.<vendor>] enabled` flag exists to close. Per call
 * rather than at construction so a key added after boot works without a Gateway restart.
 */
export type ApiKeyResolver = () => Promise<string | undefined>;

export type CloudProviderOptions = {
  apiKey: ApiKeyResolver;
  modelName: string;
  baseUrl?: string;
};

/**
 * The credential/identity half every cloud adapter shares, extracted because the four of them had
 * it verbatim three times over and a duplication gate rightly objected.
 *
 * Deliberately does NOT declare `isLocal`. Each adapter states `readonly isLocal = false` for
 * itself, one visible line at the top of the class, because that declaration is the thing
 * invariant **I34** exists to protect and hiding it in a base class would make the single most
 * dangerous field in the file the least visible one. `providerId` stays per-adapter for the same
 * reason — it is what reaches the egress ledger as `destination`.
 *
 * What IS shared is the boilerplate with no security content: holding the resolver, normalising a
 * trailing slash off `base_url`, and the two OFFLINE answers below.
 */
export abstract class CloudLlmProvider {
  protected readonly apiKey: ApiKeyResolver;
  protected readonly modelName: string;
  protected readonly baseUrl: string;

  protected constructor(opts: CloudProviderOptions, defaultBaseUrl: string) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  }

  /** The vendor id, which reaches `egress_ledger` as `destination`. */
  abstract readonly providerId: string;

  /**
   * Answered OFFLINE — enabled-and-keyed, with no network call. A `/models` probe on every
   * `nimbus llm status` would be real, un-ledgered egress to four vendors before the user ever
   * opted into sending a prompt, and would leak Nimbus usage to each of them. The accepted cost
   * is a named fail-open: a typo'd model name reports available and fails at `generate()`.
   */
  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  /** Static, for the same no-egress reason as `isAvailable`. */
  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }
}

/**
 * Resolves the key or REFUSES, auth-class, before any request is made.
 *
 * Auth and not transport, deliberately: a keyless call is a configuration mistake, and
 * classifying it transport would make `LlmRouter.generate` forward the same prompt to the next
 * vendor on the strength of it — a real outbound request and a ledger row bought by a typo.
 */
export async function requireApiKey(resolve: ApiKeyResolver, providerId: string): Promise<string> {
  const key = await resolve();
  if (key === undefined || key.trim() === "") {
    throw new LlmProviderError(`${providerId}: no API key configured`, "auth");
  }
  return key;
}

/**
 * POSTs JSON, classifying a THROWN fetch as transport-class.
 *
 * A thrown fetch is DNS / connection-refused / timeout — the case the router's priority walk
 * exists to route around. Only the error's NAME is carried into the message, never its text: a
 * fetch failure message can embed the request URL, and Gemini's URL carries the api key.
 */
export async function postJson(
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LlmProviderError(
      `${providerId}: request failed: ${err instanceof Error ? err.name : "unknown"}`,
      "transport",
    );
  }
}
