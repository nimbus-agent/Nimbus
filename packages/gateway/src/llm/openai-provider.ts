// packages/gateway/src/llm/openai-provider.ts

import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmModelInfo, LlmProvider } from "./types.ts";

/**
 * Resolves the vendor key, PER CALL, from the Vault.
 *
 * NEVER from the environment: an env var must not be able to satisfy a vendor nobody opted into,
 * which is the hole the per-vendor `[llm.remote.<vendor>] enabled` flag exists to close. Per call
 * rather than at construction so a key added after boot works without a Gateway restart.
 */
export type ApiKeyResolver = () => Promise<string | undefined>;

export type OpenAiCompatibleOptions = {
  apiKey: ApiKeyResolver;
  modelName: string;
  baseUrl?: string;
};

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

/**
 * The OpenAI chat-completions request/response mapping, shared by `OpenAiProvider` and
 * `XaiProvider` — xAI is OpenAI-compatible on the wire, and a second copy of this would be two
 * places to fix a mapping bug. Only the host, the provider id and the Vault key differ.
 */
export async function generateOpenAiCompatible(
  args: { providerId: string; baseUrl: string; modelName: string; apiKey: ApiKeyResolver },
  opts: LlmGenerateOptions,
): Promise<LlmGenerateResult> {
  const key = await args.apiKey();
  if (key === undefined || key.trim() === "") {
    // Auth-class, and thrown BEFORE any request: a keyless call has nothing to send. It must not
    // be transport-class, or the router's walk would forward the prompt to the next vendor on
    // what is really a configuration mistake.
    throw new LlmProviderError(`${args.providerId}: no API key configured`, "auth");
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt !== undefined) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: opts.prompt });

  let resp: Response;
  try {
    resp = await fetch(`${args.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: args.modelName,
        messages,
        ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      }),
    });
  } catch (err) {
    // A THROWN fetch is DNS / connection-refused / timeout — transport-class by definition, and
    // the case the router's priority walk exists to route around. Only the error's NAME is
    // carried through, never its message, which can embed the request URL.
    throw new LlmProviderError(
      `${args.providerId}: request failed: ${err instanceof Error ? err.name : "unknown"}`,
      "transport",
    );
  }

  if (!resp.ok) {
    // The vendor's own error text is deliberately NOT echoed: OpenAI 401 bodies have been
    // observed quoting the submitted key back, and this message reaches the user through
    // `SynthesisAttempt.detail` on `briefReady`. Vendor plus status is enough to act on.
    throw new LlmProviderError(
      `${args.providerId}: HTTP ${String(resp.status)}`,
      classifyHttpStatus(resp.status),
      resp.status,
    );
  }

  const body = (await resp.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const raw = body.choices?.[0]?.message?.content;
  return {
    text: typeof raw === "string" ? raw : "",
    tokensIn: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : 0,
    tokensOut: typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : 0,
    modelUsed: args.modelName,
    isLocal: false,
    provider: args.providerId,
  };
}

/**
 * OpenAI chat-completions adapter.
 *
 * `isLocal` is HARDCODED FALSE and is never derived from `baseUrl`. This is the INVERSE of the
 * rule `OllamaProvider` / `LlamaCppProvider` follow, and the easiest thing in this slice to get
 * backwards: those runtimes derive locality because their base URL can legitimately name a LAN
 * box, whereas pointing THIS adapter at `http://127.0.0.1:4000` only names a proxy that forwards
 * to OpenAI. Pinned by invariant I34.
 */
export class OpenAiProvider implements LlmProvider {
  readonly providerId = "openai";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiCompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Answered OFFLINE — enabled-and-keyed, with no network call. A `/models` probe on every
   * `nimbus llm status` would be real, un-ledgered egress to the vendor before the user ever
   * opted into sending a prompt, and would leak Nimbus usage to them. The accepted cost is a
   * named fail-open: a typo'd model name reports available and fails at `generate()`.
   */
  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  /** Static, for the same no-egress reason as `isAvailable`. */
  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    return generateOpenAiCompatible(
      {
        providerId: this.providerId,
        baseUrl: this.baseUrl,
        modelName: this.modelName,
        apiKey: this.apiKey,
      },
      opts,
    );
  }
}
