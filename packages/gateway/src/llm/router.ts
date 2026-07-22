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

export type LlmTaskStatus = {
  providerId: LlmProviderKind;
  modelName: string;
  isAvailable: boolean;
  reason: string;
  // Populated only when the preferred provider is unavailable: the provider generate() would
  // actually fall back to, so the status reflects real routing rather than just config intent.
  fallback?: { providerId: LlmProviderKind; modelName: string };
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

  // `opts.preferLocal` overrides `config.preferLocal` for this call only (e.g. research briefs
  // honoring `[briefs].prefer_local` independently of `[llm].prefer_local` — source text is
  // privacy-sensitive enough to warrant its own knob). Omitted, behavior is unchanged.
  async selectProvider(
    task: LlmTaskType,
    opts?: { preferLocal?: boolean },
  ): Promise<LlmProvider | undefined> {
    return this.firstAvailable(task, (p) => this.probeAvailable(p), opts?.preferLocal);
  }

  // Walks the task's provider priority order (respecting air-gap and the capability floor) and
  // returns the first provider whose availability check resolves true. The check is injected so
  // callers can share a memoized probe across many tasks (see getStatus). `preferLocal`, when
  // provided, overrides `config.preferLocal` for this call only.
  private async firstAvailable(
    task: LlmTaskType,
    isAvailable: (provider: LlmProvider) => Promise<boolean>,
    preferLocal?: boolean,
  ): Promise<LlmProvider | undefined> {
    for (const id of this.providerPriority(task, preferLocal)) {
      if (this.config.enforceAirGap && !LOCAL_PROVIDER_IDS.has(id)) continue;
      if (!this.meetsCapabilityFloor(id, task)) continue;
      const provider = this.providers.get(id);
      if (provider === undefined) continue;
      if (await isAvailable(provider)) return provider;
    }
    return undefined;
  }

  private async probeAvailable(provider: LlmProvider): Promise<boolean> {
    try {
      return await provider.isAvailable();
    } catch {
      return false; // treat availability check failure as unavailable
    }
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
    // NOTE: this returns the global local/remote model from config. Per-task overrides set via
    // llm.setDefault (stored in llm_task_defaults) are not consulted here because the router
    // has no DB access. If per-task dispatch is wired to respect those overrides in the future,
    // this method should be updated to accept a task argument and query the registry.
    return LOCAL_PROVIDER_IDS.has(providerId) ? this.config.localModel : this.config.remoteModel;
  }

  private reasonFor(task: LlmTaskType, providerId: LlmProviderKind): string {
    const isLocal = LOCAL_PROVIDER_IDS.has(providerId);
    if (this.config.enforceAirGap && isLocal) return "air-gap";
    if (this.config.preferLocal && isLocal) return "prefer-local";
    if (!this.config.preferLocal && !isLocal) return "prefer-remote";
    // The preferred provider does not match the configured preference.
    if (this.config.preferLocal && !isLocal) {
      // A local provider may be registered but skipped because it falls below the reasoning
      // capability floor — distinguish that from "no local provider registered at all".
      return this.localProviderBelowFloor(task)
        ? "local-below-reasoning-floor"
        : "no-local-provider";
    }
    return "no-remote-provider";
  }

  // True when a local provider is registered for this task but was excluded by the reasoning
  // capability floor (only reasoning/agent_step carry a floor).
  private localProviderBelowFloor(task: LlmTaskType): boolean {
    for (const id of this.providers.keys()) {
      if (!LOCAL_PROVIDER_IDS.has(id)) continue;
      if (!this.meetsCapabilityFloor(id, task)) return true;
    }
    return false;
  }

  // Finds the highest-priority provider for a task based on config (priority order, capability
  // floor, air-gap) WITHOUT calling isAvailable(). Used by getStatus() so that the status entry
  // reflects config intent; isAvailable() is then probed separately.
  private findPreferred(task: LlmTaskType): LlmProvider | undefined {
    const orderedIds = this.providerPriority(task);
    for (const id of orderedIds) {
      if (this.config.enforceAirGap && !LOCAL_PROVIDER_IDS.has(id)) continue;
      if (!this.meetsCapabilityFloor(id, task)) continue;
      const provider = this.providers.get(id);
      if (provider !== undefined) return provider;
    }
    return undefined;
  }

  async getStatus(): Promise<Record<LlmTaskType, LlmTaskStatus | undefined>> {
    const tasks: LlmTaskType[] = ["classification", "reasoning", "summarisation", "agent_step"];
    const out: Partial<Record<LlmTaskType, LlmTaskStatus | undefined>> = {};
    // Probe each provider's availability at most once for the whole call.
    const availabilityCache = new Map<LlmProviderKind, Promise<boolean>>();
    const cachedAvailable = (provider: LlmProvider): Promise<boolean> => {
      let probe = availabilityCache.get(provider.providerId);
      if (probe === undefined) {
        probe = this.probeAvailable(provider);
        availabilityCache.set(provider.providerId, probe);
      }
      return probe;
    };
    for (const t of tasks) {
      const preferred = this.findPreferred(t);
      if (preferred === undefined) {
        out[t] = undefined;
        continue;
      }
      const isAvailable = await cachedAvailable(preferred);
      const entry: LlmTaskStatus = {
        providerId: preferred.providerId,
        modelName: this.modelNameFor(preferred.providerId),
        isAvailable,
        reason: this.reasonFor(t, preferred.providerId),
      };
      if (!isAvailable) {
        // The preferred provider is down; report the provider generate() would actually fall
        // back to (next available in priority order) so status matches real routing.
        const actual = await this.firstAvailable(t, cachedAvailable);
        if (actual !== undefined && actual.providerId !== preferred.providerId) {
          entry.fallback = {
            providerId: actual.providerId,
            modelName: this.modelNameFor(actual.providerId),
          };
        }
      }
      out[t] = entry;
    }
    return out as Record<LlmTaskType, LlmTaskStatus | undefined>;
  }

  private providerPriority(
    _task: LlmTaskType,
    preferLocal: boolean = this.config.preferLocal,
  ): LlmProviderKind[] {
    if (preferLocal) {
      return ["ollama", "llamacpp", "remote"];
    }
    return ["remote", "ollama", "llamacpp"];
  }
}
