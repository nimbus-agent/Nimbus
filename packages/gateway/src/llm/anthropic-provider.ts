// packages/gateway/src/llm/anthropic-provider.ts

import {
  CloudLlmProvider,
  type CloudProviderOptions,
  postJson,
  requireApiKey,
} from "./cloud-provider-base.ts";
import {
  asJsonArray,
  asJsonRecord,
  classifyHttpStatus,
  LlmProviderError,
  readJsonBody,
} from "./provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "./types.ts";

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
export class AnthropicProvider extends CloudLlmProvider implements LlmProvider {
  readonly providerId = "anthropic";
  readonly isLocal = false;
  constructor(opts: CloudProviderOptions) {
    super(opts, ANTHROPIC_DEFAULT_BASE_URL);
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = await requireApiKey(this.apiKey, this.providerId);

    const resp = await postJson(
      this.providerId,
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      {
        model: this.modelName,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // `system` is a TOP-LEVEL field here, not a message with role "system".
        ...(opts.systemPrompt === undefined ? {} : { system: opts.systemPrompt }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
        messages: [{ role: "user", content: opts.prompt }],
      },
    );

    if (!resp.ok) {
      // The vendor's error text is deliberately NOT echoed — it can quote the submitted key back,
      // and this message reaches the user through `SynthesisAttempt.detail` on `briefReady`.
      throw new LlmProviderError(
        `anthropic: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = asJsonRecord(await readJsonBody(resp, this.providerId));
    // CONCATENATE every text block. The array can hold several, plus non-text blocks such as
    // `thinking`; taking only [0] would silently truncate a multi-block reply. `asJsonArray`
    // matters as much as the concatenation: `content` arriving as an OBJECT would make `.filter`
    // throw a TypeError the router cannot classify.
    const text = asJsonArray(body["content"])
      .map((b) => asJsonRecord(b))
      .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("");
    const usage = asJsonRecord(body["usage"]);

    return {
      text,
      tokensIn: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0,
      tokensOut: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
}
