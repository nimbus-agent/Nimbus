// packages/gateway/src/llm/xai-provider.ts

import { CloudLlmProvider, type CloudProviderOptions } from "./cloud-provider-base.ts";
import { generateOpenAiCompatible } from "./openai-provider.ts";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "./types.ts";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai";

/**
 * xAI adapter. Same wire format as OpenAI, so it delegates to `generateOpenAiCompatible` — a
 * second copy of the request/response mapping would be two places to fix a mapping bug. Only the
 * host, the provider id and the Vault key differ.
 *
 * `isLocal` is HARDCODED FALSE and never derived from `baseUrl`; see `OpenAiProvider`'s note.
 * Invariant I34.
 */
export class XaiProvider extends CloudLlmProvider implements LlmProvider {
  readonly providerId = "xai";
  readonly isLocal = false;
  constructor(opts: CloudProviderOptions) {
    super(opts, XAI_DEFAULT_BASE_URL);
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
