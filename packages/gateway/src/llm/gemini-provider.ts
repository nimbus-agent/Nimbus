// packages/gateway/src/llm/gemini-provider.ts

import type { ApiKeyResolver, OpenAiCompatibleOptions } from "./openai-provider.ts";
import { classifyHttpStatus, LlmProviderError } from "./provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmModelInfo, LlmProvider } from "./types.ts";

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Gemini `generateContent` adapter — the third wire format in this slice.
 *
 * Two things are unlike the other two vendors and drive the code below: the MODEL goes in the
 * URL PATH, and the KEY goes in the URL QUERY rather than a header. The second is why no error
 * message here ever includes the request URL: doing so would leak the credential into
 * `SynthesisAttempt.detail`, which reaches the user on `briefReady`.
 *
 * `isLocal` is HARDCODED FALSE and never derived from `baseUrl`; see `OpenAiProvider`'s note and
 * invariant I34.
 */
export class GeminiProvider implements LlmProvider {
  readonly providerId = "gemini";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiCompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/$/, "");
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
      throw new LlmProviderError("gemini: no API key configured", "auth");
    }

    // `encodeURIComponent` on the model is load-bearing: an id containing `/` or a space would
    // otherwise change the path's meaning.
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent` +
      `?key=${encodeURIComponent(key)}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
          ...(opts.systemPrompt === undefined
            ? {}
            : { systemInstruction: { parts: [{ text: opts.systemPrompt }] } }),
          ...(opts.maxTokens === undefined && opts.temperature === undefined
            ? {}
            : {
                generationConfig: {
                  ...(opts.maxTokens === undefined ? {} : { maxOutputTokens: opts.maxTokens }),
                  ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
                },
              }),
        }),
      });
    } catch (err) {
      // Only the error's NAME, never its message: a fetch failure message can embed the request
      // URL, and this vendor's URL carries the api key.
      throw new LlmProviderError(
        `gemini: request failed: ${err instanceof Error ? err.name : "unknown"}`,
        "transport",
      );
    }

    if (!resp.ok) {
      throw new LlmProviderError(
        `gemini: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
    };
    // CONCATENATE every part, for the same reason Anthropic's blocks are concatenated: taking
    // only [0] would silently truncate a multi-part reply.
    const text = (body.candidates?.[0]?.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    const usage = body.usageMetadata;

    return {
      text,
      tokensIn: typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : 0,
      tokensOut: typeof usage?.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
}
