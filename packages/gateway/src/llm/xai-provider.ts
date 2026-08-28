// packages/gateway/src/llm/xai-provider.ts

import {
  type ApiKeyResolver,
  generateOpenAiCompatible,
  type OpenAiCompatibleOptions,
} from "./openai-provider.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmModelInfo, LlmProvider } from "./types.ts";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai";

/**
 * xAI adapter. Same wire format as OpenAI, so it delegates to `generateOpenAiCompatible` — a
 * second copy of the request/response mapping would be two places to fix a mapping bug. Only the
 * host, the provider id and the Vault key differ.
 *
 * `isLocal` is HARDCODED FALSE and never derived from `baseUrl`; see `OpenAiProvider`'s note.
 * Invariant I34.
 */
export class XaiProvider implements LlmProvider {
  readonly providerId = "xai";
  readonly isLocal = false;
  private readonly apiKey: ApiKeyResolver;
  private readonly modelName: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAiCompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? XAI_DEFAULT_BASE_URL).replace(/\/$/, "");
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
