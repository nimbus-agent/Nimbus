export type LlmTaskType = "classification" | "reasoning" | "summarisation" | "agent_step";

/**
 * A provider VENDOR id — `"ollama"`, `"llamacpp"`, and (slice 2) `"gemini"`,
 * `"bedrock"`, ... Deliberately an open string, not a union: the closed union it
 * replaced capped `LlmRouter.providers` at one provider per kind, so registering a
 * second vendor silently evicted the first.
 *
 * NOT unique across routes — two Ollama routes share `"ollama"`. Route identity is
 * `ModelRoute.routeId`. This is the value that reaches the egress ledger as
 * `destination`, so it names a place data can go.
 */
export type ProviderId = string;

export type ModelRoute = {
  readonly routeId: string;
  readonly provider: LlmProvider;
  readonly modelName: string;
  readonly meta: ProviderMeta;
};

export type ProviderMeta = {
  parameterCount?: number;
  contextWindow?: number;
};

export type LlmModelInfo = {
  provider: ProviderId;
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
  provider: ProviderId;
};

export type PullProgressChunk = {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
};

export interface LlmProvider {
  readonly providerId: ProviderId;
  /**
   * Whether this provider runs on this machine. REQUIRED, so omitting it is a
   * compile error rather than a silent `undefined`.
   *
   * Declared by the provider rather than looked up in a module-private set,
   * because that set existed in three places that had to agree. Note the failure
   * direction is safe either way: an unset value is falsy, i.e. REMOTE — which
   * air-gap refuses and the egress appender ledgers.
   */
  readonly isLocal: boolean;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<LlmModelInfo[]>;
  generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult>;
  pullModel?(
    modelName: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void },
  ): Promise<void>;
}
