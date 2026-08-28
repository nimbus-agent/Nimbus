// packages/gateway/src/llm/openai-provider.ts

import {
  type ApiKeyResolver,
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
  const key = await requireApiKey(args.apiKey, args.providerId);

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.systemPrompt !== undefined) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: opts.prompt });

  const resp = await postJson(
    args.providerId,
    `${args.baseUrl}/v1/chat/completions`,
    { Authorization: `Bearer ${key}` },
    {
      model: args.modelName,
      messages,
      ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    },
  );

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

  // Parsed as `unknown` and narrowed, never `as`-asserted: a literal `null` body satisfies the
  // compiler and then throws on the first property read.
  const body = asJsonRecord(await readJsonBody(resp, args.providerId));
  const first = asJsonRecord(asJsonArray(body["choices"])[0]);
  const raw = asJsonRecord(first["message"])["content"];
  const usage = asJsonRecord(body["usage"]);
  return {
    text: typeof raw === "string" ? raw : "",
    tokensIn: typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : 0,
    tokensOut: typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : 0,
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
export class OpenAiProvider extends CloudLlmProvider implements LlmProvider {
  readonly providerId = "openai";
  readonly isLocal = false;
  constructor(opts: CloudProviderOptions) {
    super(opts, OPENAI_DEFAULT_BASE_URL);
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
