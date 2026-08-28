// packages/gateway/src/llm/anthropic-provider.ts

import type { ApiKeyResolver, OpenAiCompatibleOptions } from "./openai-provider.ts";
import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmModelInfo, LlmProvider } from "./types.ts";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Pinned rather than floating: a version bump can change response shapes under us. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Required by the API — a request without `max_tokens` is rejected with a 400. Supplying a
 * default keeps a caller that omits `maxTokens` producing a VALID request, instead of a 400 that
 * reads like a malformed prompt.
 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic messages-API adapter.
 *
 * A different wire format from `OpenAiProvider`, not a variant of it: authentication is
 * `x-api-key` rather than `Authorization: Bearer`, an explicit `anthropic-version` header is
 * mandatory, `system` is a top-level field rather than a message, and the reply is an ARRAY of
 * content blocks.
 *
 * `isLocal` is HARDCODED FALSE and never derived from `baseUrl`; see `OpenAiProvider`'s note and
 * invariant I34.
 */
export class AnthropicProvider implements LlmProvider {
  readonly providerId = "anthropic";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiCompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /** Offline; see `OpenAiProvider.isAvailable` for why no probe is issued. */
  async isAvailable(): Promise<boolean> {
    const key = await this.apiKey();
    return key !== undefined && key.trim() !== "";
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return [{ provider: this.providerId, modelName: this.modelName }];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = await this.apiKey();
    if (key === undefined || key.trim() === "") {
      // Auth-class, before any request: a keyless call has nothing to send, and classifying it
      // transport would make the router forward the prompt to the next vendor on what is really
      // a configuration mistake.
      throw new LlmProviderError("anthropic: no API key configured", "auth");
    }

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.modelName,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          // `system` is a TOP-LEVEL field here, not a message with role "system".
          ...(opts.systemPrompt === undefined ? {} : { system: opts.systemPrompt }),
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          messages: [{ role: "user", content: opts.prompt }],
        }),
      });
    } catch (err) {
      throw new LlmProviderError(
        `anthropic: request failed: ${err instanceof Error ? err.name : "unknown"}`,
        "transport",
      );
    }

    if (!resp.ok) {
      // The vendor's error text is deliberately NOT echoed — it can quote the submitted key back,
      // and this message reaches the user through `SynthesisAttempt.detail` on `briefReady`.
      throw new LlmProviderError(
        `anthropic: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = (await resp.json()) as {
      content?: Array<{ type?: unknown; text?: unknown }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    // CONCATENATE every text block. The array can hold several, plus non-text blocks such as
    // `thinking`; taking only [0] would silently truncate a multi-block reply.
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    return {
      text,
      tokensIn: typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : 0,
      tokensOut: typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : 0,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
}
