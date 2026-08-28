// packages/gateway/src/llm/gemini-provider.ts

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
export class GeminiProvider extends CloudLlmProvider implements LlmProvider {
  readonly providerId = "gemini";
  readonly isLocal = false;
  constructor(opts: CloudProviderOptions) {
    super(opts, GEMINI_DEFAULT_BASE_URL);
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const key = await requireApiKey(this.apiKey, this.providerId);

    // `encodeURIComponent` on the model is load-bearing: an id containing `/` or a space would
    // otherwise change the path's meaning. The KEY rides in the query string, which is why no
    // error below ever includes this URL.
    const url =
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent` +
      `?key=${encodeURIComponent(key)}`;

    const resp = await postJson(
      this.providerId,
      url,
      {},
      {
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
      },
    );

    if (!resp.ok) {
      throw new LlmProviderError(
        `gemini: HTTP ${String(resp.status)}`,
        classifyHttpStatus(resp.status),
        resp.status,
      );
    }

    const body = asJsonRecord(await readJsonBody(resp, this.providerId));
    // CONCATENATE every part, for the same reason Anthropic's blocks are concatenated: taking
    // only [0] would silently truncate a multi-part reply.
    const firstCandidate = asJsonRecord(asJsonArray(body["candidates"])[0]);
    const parts = asJsonArray(asJsonRecord(firstCandidate["content"])["parts"]);
    const text = parts
      .map((part) => asJsonRecord(part)["text"])
      .map((t) => (typeof t === "string" ? t : ""))
      .join("");
    const usage = asJsonRecord(body["usageMetadata"]);

    return {
      text,
      tokensIn: typeof usage["promptTokenCount"] === "number" ? usage["promptTokenCount"] : 0,
      tokensOut:
        typeof usage["candidatesTokenCount"] === "number" ? usage["candidatesTokenCount"] : 0,
      modelUsed: this.modelName,
      isLocal: false,
      provider: this.providerId,
    };
  }
}
