import { isLoopbackBaseUrl } from "./base-url-locality.ts";
import type {
  LlmGenerateOptions,
  LlmGenerateResult,
  LlmModelInfo,
  LlmProvider,
  PullProgressChunk,
} from "./types.ts";

type OllamaTagsModel = {
  name?: unknown;
  details?: { parameter_size?: unknown; quantization_level?: unknown };
  size?: unknown;
};

type OllamaTagsResponse = {
  models?: OllamaTagsModel[];
};

type OllamaGenerateChunk = {
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};

function parseBillions(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^([\d.]+)B$/i.exec(raw.trim());
  if (m === null) return undefined;
  const n = Number.parseFloat(m[1] ?? "");
  return Number.isFinite(n) ? n : undefined;
}

function parseVramMb(sizeBytes: unknown): number | undefined {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) return undefined;
  return Math.round(sizeBytes / (1024 * 1024));
}

function processStreamLine(
  line: string,
  state: { text: string; tokensIn: number; tokensOut: number },
  onToken?: (token: string) => void,
): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  try {
    const chunk = JSON.parse(trimmed) as OllamaGenerateChunk;
    const token = chunk.response ?? "";
    if (token !== "") {
      state.text += token;
      onToken?.(token);
    }
    if (chunk.done === true) {
      state.tokensIn = chunk.prompt_eval_count ?? 0;
      state.tokensOut = chunk.eval_count ?? 0;
    }
  } catch {
    /* ignore malformed chunk lines */
  }
}

function parseOllamaModel(raw: OllamaTagsModel): LlmModelInfo | undefined {
  if (typeof raw.name !== "string" || raw.name === "") return undefined;
  const parameterCount = parseBillions(raw.details?.parameter_size);
  const quantizationLevel = raw.details?.quantization_level;
  const quantization = typeof quantizationLevel === "string" ? quantizationLevel : undefined;
  const vramEstimateMb = parseVramMb(raw.size);
  return {
    provider: "ollama",
    modelName: raw.name,
    ...(parameterCount !== undefined && { parameterCount }),
    ...(quantization !== undefined && { quantization }),
    ...(vramEstimateMb !== undefined && { vramEstimateMb }),
  };
}

/**
 * The prompt window Nimbus asks Ollama for, in tokens, when the caller names no other.
 *
 * Sending NOTHING is not neutral. Ollama then applies its own default of 4096 regardless of
 * what the model supports — `llama3.2` handles 128k — and silently drops whatever does not fit
 * from the front of the prompt. That window has to hold the system prompt, up to twelve prior
 * turns, the question, the indexed context AND the 2048 tokens `num_predict` reserves for the
 * answer, so eight context items at 900 preview chars can exhaust it in any conversation with
 * history, with no error and no report.
 *
 * That is strictly worse than the truncation invariant F14 discloses: this one happens after
 * Nimbus has handed the prompt over, where nothing can see it. It also BOUNDS that disclosure —
 * "written from 8 indexed items" describes what Nimbus sent, and only stays true of what the
 * model read while the prompt is not trimmed underneath it.
 *
 * 8192 doubles the headroom while staying cheap on the small local models this path targets. It
 * is a DEFAULT, not a ceiling: `[llm] local_context_tokens` overrides it, because the RAM and
 * prompt-eval cost land on the user's machine and only its owner can price them.
 */
export const DEFAULT_LOCAL_CONTEXT_TOKENS = 8192;

export class OllamaProvider implements LlmProvider {
  readonly providerId = "ollama" as const;
  /**
   * DERIVED from the resolved base URL, never hardcoded. An Ollama daemon is reachable over the
   * network and `[llm.local.<name>] base_url` accepts a remote host, so "ollama" says nothing
   * about where the weights run. Hardcoding `true` made `[llm] enforce_air_gap` skip its own
   * exclusion for a LAN daemon. See `base-url-locality.ts`.
   */
  readonly isLocal: boolean;
  private readonly baseUrl: string;
  private readonly modelName: string;
  private readonly contextTokens: number;

  constructor(
    baseUrl = "http://127.0.0.1:11434",
    modelName = "llama3.2",
    contextTokens: number = DEFAULT_LOCAL_CONTEXT_TOKENS,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.modelName = modelName;
    this.contextTokens = contextTokens;
    this.isLocal = isLoopbackBaseUrl(this.baseUrl);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<LlmModelInfo[]> {
    const resp = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(`Ollama listModels HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as OllamaTagsResponse;
    if (!Array.isArray(data.models)) return [];
    const out: LlmModelInfo[] = [];
    for (const m of data.models) {
      const parsed = parseOllamaModel(m);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  async generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    if (opts.stream === true) {
      return this.generateStream(opts);
    }
    return this.generateBatch(opts);
  }

  private async generateBatch(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const body = {
      model: this.modelName,
      prompt: opts.prompt,
      system: opts.systemPrompt,
      stream: false,
      options: {
        num_ctx: this.contextTokens,
        num_predict: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.7,
      },
    };
    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`Ollama generate HTTP ${resp.status}`);
    const data = (await resp.json()) as OllamaGenerateChunk;
    return {
      text: typeof data.response === "string" ? data.response : "",
      tokensIn: data.prompt_eval_count ?? 0,
      tokensOut: data.eval_count ?? 0,
      modelUsed: this.modelName,
      isLocal: this.isLocal,
      provider: "ollama",
    };
  }

  private async generateStream(opts: LlmGenerateOptions): Promise<LlmGenerateResult> {
    const body = {
      model: this.modelName,
      prompt: opts.prompt,
      system: opts.systemPrompt,
      stream: true,
      options: {
        num_ctx: this.contextTokens,
        num_predict: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.7,
      },
    };
    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) throw new Error(`Ollama stream HTTP ${resp.status}`);

    const reader = resp.body?.getReader();
    if (reader === undefined) throw new Error("No response body");

    const decoder = new TextDecoder();
    const state = { text: "", tokensIn: 0, tokensOut: 0 };
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        processStreamLine(line, state, opts.onToken);
      }
    }
    return {
      text: state.text,
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
      modelUsed: this.modelName,
      isLocal: this.isLocal,
      provider: "ollama",
    };
  }

  async pullModel(
    modelName: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void } = {},
  ): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, stream: true }),
      signal: opts.signal ?? null,
    });
    if (!resp.ok) throw new Error(`Ollama pullModel HTTP ${resp.status}`);
    const reader = resp.body?.getReader();
    if (reader === undefined) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const progress = parseOllamaPullChunk(line.trim());
        if (progress !== null) opts.onProgress?.(progress);
      }
    }
  }
}

function parseOllamaPullChunk(trimmed: string): PullProgressChunk | null {
  if (trimmed === "") return null;
  try {
    const chunk = JSON.parse(trimmed) as {
      status?: unknown;
      completed?: unknown;
      total?: unknown;
    };
    return {
      status: typeof chunk.status === "string" ? chunk.status : "",
      ...(typeof chunk.completed === "number" && { completedBytes: chunk.completed }),
      ...(typeof chunk.total === "number" && { totalBytes: chunk.total }),
    };
  } catch {
    return null;
  }
}
