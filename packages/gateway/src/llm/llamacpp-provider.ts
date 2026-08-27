import type { LlmGenerateOptions, LlmGenerateResult, LlmModelInfo, LlmProvider } from "./types.ts";

type LlamaCppCompletionResponse = {
  content?: string;
  timings?: { prompt_n?: number; predicted_n?: number };
};

export class LlamaCppProvider implements LlmProvider {
  readonly providerId = "llamacpp" as const;
  readonly isLocal = true;
  private readonly baseUrl: string;
  private readonly modelName: string;

  constructor(baseUrl = "http://127.0.0.1:8080", modelName = "model.gguf") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.modelName = modelName;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return [
      {
        provider: "llamacpp",
        modelName: this.modelName,
      },
    ];
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const body = {
      prompt: opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt,
      n_predict: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
      stream: false,
    };
    const resp = await fetch(`${this.baseUrl}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`llama.cpp generate HTTP ${resp.status}`);
    const data = (await resp.json()) as LlamaCppCompletionResponse;
    const text = typeof data.content === "string" ? data.content : "";
    return {
      text,
      tokensIn: data.timings?.prompt_n ?? 0,
      tokensOut: data.timings?.predicted_n ?? 0,
      modelUsed: this.modelName,
      isLocal: true,
      provider: "llamacpp",
    };
  }
}
