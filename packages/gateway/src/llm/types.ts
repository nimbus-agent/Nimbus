export type LlmTaskType = "classification" | "reasoning" | "summarisation" | "agent_step";

export type LlmProviderKind = "ollama" | "llamacpp" | "remote";

export type LlmModelInfo = {
  provider: LlmProviderKind;
  modelName: string;
  parameterCount?: number;
  contextWindow?: number;
  quantization?: string;
  vramEstimateMb?: number;
};

export type LlmGenerateOptions = {
  task: LlmTaskType;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
};

export type LlmGenerateResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  modelUsed: string;
  isLocal: boolean;
  provider: LlmProviderKind;
};

export type PullProgressChunk = {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
};

export interface LlmProvider {
  readonly providerId: LlmProviderKind;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<LlmModelInfo[]>;
  generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult>;
  pullModel?(
    modelName: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void },
  ): Promise<void>;
}
