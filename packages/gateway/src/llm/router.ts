import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmProvider,
  LlmProviderKind,
  LlmTaskType,
} from "./types.ts";

export type LlmRouterConfig = {
  preferLocal: boolean;
  remoteModel: string;
  localModel: string;
  minReasoningParams: number;
  enforceAirGap: boolean;
};

export type ProviderMeta = {
  parameterCount?: number;
  contextWindow?: number;
};

const LOCAL_PROVIDER_IDS: ReadonlySet<LlmProviderKind> = new Set(["ollama", "llamacpp"]);
const CONTEXT_OVERFLOW_THRESHOLD = 0.85;
const TOKENS_PER_CHAR = 4;

export function midTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor(maxChars / 2);
  return `${text.slice(0, keep)}\n[...truncated...]\n${text.slice(-keep)}`;
}

export class LlmRouter {
  private readonly providers = new Map<LlmProviderKind, LlmProvider>();
  private readonly providerMeta = new Map<LlmProviderKind, ProviderMeta>();
  private readonly config: LlmRouterConfig;

  constructor(config: LlmRouterConfig) {
    this.config = config;
  }

  registerProvider(provider: LlmProvider, meta: ProviderMeta = {}): void {
    this.providers.set(provider.providerId, provider);
    this.providerMeta.set(provider.providerId, meta);
  }

  prefersLocal(): boolean {
    return this.config.preferLocal;
  }

  async selectProvider(task: LlmTaskType): Promise<LlmProvider | undefined> {
    const orderedIds = this.providerPriority(task);
    for (const id of orderedIds) {
      if (this.config.enforceAirGap && !LOCAL_PROVIDER_IDS.has(id)) {
        continue;
      }
      if (!this.meetsCapabilityFloor(id, task)) {
        continue;
      }
      const provider = this.providers.get(id);
      if (provider === undefined) continue;
      try {
        if (await provider.isAvailable()) return provider;
      } catch {
        /* treat availability check failure as unavailable */
      }
    }
    return undefined;
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const provider = await this.selectProvider(opts.task);
    if (provider === undefined) {
      throw new Error(`No LLM provider available for task: ${opts.task}`);
    }
    const adjusted = await this.fitPromptOrFallback(opts, provider.providerId);
    if (adjusted.kind === "remote-result") {
      return adjusted.result;
    }
    return provider.generate(adjusted.opts);
  }

  private async fitPromptOrFallback(
    opts: LlmGenerateOptions,
    providerId: LlmProviderKind,
  ): Promise<
    | { kind: "opts"; opts: LlmGenerateOptions }
    | { kind: "remote-result"; result: LlmGenerateResult }
  > {
    const meta = this.providerMeta.get(providerId);
    if (meta?.contextWindow === undefined) {
      return { kind: "opts", opts };
    }
    const estimatedTokens = Math.ceil(opts.prompt.length / TOKENS_PER_CHAR);
    const tokenLimit = Math.floor(meta.contextWindow * CONTEXT_OVERFLOW_THRESHOLD);
    if (estimatedTokens <= tokenLimit) {
      return { kind: "opts", opts };
    }
    const truncated = {
      ...opts,
      prompt: midTruncate(opts.prompt, tokenLimit * TOKENS_PER_CHAR),
    };
    if (opts.task === "summarisation" || opts.task === "classification") {
      return { kind: "opts", opts: truncated };
    }
    if (this.config.enforceAirGap) {
      throw new Error(
        `Prompt exceeds provider context window and air-gap mode prevents remote fallback`,
      );
    }
    const remoteResult = await this.tryRemoteFallback(opts);
    if (remoteResult !== undefined) {
      return { kind: "remote-result", result: remoteResult };
    }
    return { kind: "opts", opts: truncated };
  }

  private async tryRemoteFallback(
    opts: LlmGenerateOptions,
  ): Promise<LlmGenerateResult | undefined> {
    const remote = this.providers.get("remote");
    if (remote === undefined) {
      return undefined;
    }
    try {
      if (await remote.isAvailable()) {
        return await remote.generate(opts);
      }
    } catch {
      /* treat as unavailable */
    }
    return undefined;
  }

  private meetsCapabilityFloor(id: LlmProviderKind, task: LlmTaskType): boolean {
    if (task !== "reasoning" && task !== "agent_step") return true;
    const meta = this.providerMeta.get(id);
    if (meta?.parameterCount === undefined) return true;
    return meta.parameterCount >= this.config.minReasoningParams;
  }

  private modelNameFor(providerId: LlmProviderKind): string {
    return LOCAL_PROVIDER_IDS.has(providerId) ? this.config.localModel : this.config.remoteModel;
  }

  private reasonFor(providerId: LlmProviderKind): string {
    const isLocal = LOCAL_PROVIDER_IDS.has(providerId);
    if (this.config.enforceAirGap && isLocal) return "air-gap";
    if (this.config.preferLocal && isLocal) return "prefer-local";
    if (!this.config.preferLocal && !isLocal) return "prefer-remote";
    return "default";
  }

  async getStatus(): Promise<
    Record<
      LlmTaskType,
      | { providerId: LlmProviderKind; modelName: string; isAvailable: boolean; reason: string }
      | undefined
    >
  > {
    const tasks: LlmTaskType[] = ["classification", "reasoning", "summarisation", "agent_step"];
    const out: Partial<
      Record<
        LlmTaskType,
        | { providerId: LlmProviderKind; modelName: string; isAvailable: boolean; reason: string }
        | undefined
      >
    > = {};
    for (const t of tasks) {
      const provider = await this.selectProvider(t);
      if (provider === undefined) {
        out[t] = undefined;
        continue;
      }
      out[t] = {
        providerId: provider.providerId,
        modelName: this.modelNameFor(provider.providerId),
        isAvailable: true,
        reason: this.reasonFor(provider.providerId),
      };
    }
    return out as Record<
      LlmTaskType,
      | { providerId: LlmProviderKind; modelName: string; isAvailable: boolean; reason: string }
      | undefined
    >;
  }

  private providerPriority(_task: LlmTaskType): LlmProviderKind[] {
    if (this.config.preferLocal) {
      return ["ollama", "llamacpp", "remote"];
    }
    return ["remote", "ollama", "llamacpp"];
  }
}
