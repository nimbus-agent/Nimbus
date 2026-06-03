import type { LlmRegistry } from "../llm/registry.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class LlmRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "LlmRpcError";
    this.rpcCode = rpcCode;
  }
}

export type LlmRpcContext = {
  registry: LlmRegistry;
  notify: (method: string, params: unknown) => void;
};

const activePulls = new Map<string, AbortController>();

const VALID_LLM_TASKS = new Set(["classification", "reasoning", "summarisation", "agent_step"]);
const VALID_LLM_PROVIDERS = new Set(["ollama", "llamacpp", "remote"]);
const LOCAL_PROVIDERS = ["ollama", "llamacpp"] as const;
type LocalProvider = (typeof LOCAL_PROVIDERS)[number];

function requireLocalProvider(provider: string): LocalProvider {
  if (provider !== "ollama" && provider !== "llamacpp") {
    throw new LlmRpcError(-32602, `Unsupported provider: ${provider}`);
  }
  return provider;
}

function requireModelParams(
  params: unknown,
  action: string,
): { provider: LocalProvider; modelName: string } {
  const p = params as { provider?: string; modelName?: string } | null;
  if (p === null || typeof p.modelName !== "string") {
    throw new LlmRpcError(-32602, `${action} requires modelName`);
  }
  return { provider: requireLocalProvider(p.provider ?? "ollama"), modelName: p.modelName };
}

async function handlePullModel(params: unknown, ctx: LlmRpcContext): Promise<{ pullId: string }> {
  const { provider, modelName } = requireModelParams(params, "pullModel");
  const pullId = `pull_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  activePulls.set(pullId, controller);
  void ctx.registry
    .pullModel(provider, modelName, {
      signal: controller.signal,
      onProgress: (c) => ctx.notify("llm.pullProgress", { pullId, provider, modelName, ...c }),
    })
    .then(() => ctx.notify("llm.pullCompleted", { pullId, provider, modelName }))
    .catch((err: unknown) =>
      ctx.notify("llm.pullFailed", {
        pullId,
        provider,
        modelName,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .finally(() => activePulls.delete(pullId));
  return { pullId };
}

async function handleLoadOrUnload(
  action: "load" | "unload",
  params: unknown,
  ctx: LlmRpcContext,
): Promise<{ isLoaded: boolean }> {
  const { provider, modelName } = requireModelParams(params, `${action}Model`);
  if (action === "load") {
    await ctx.registry.loadModel(provider, modelName);
    ctx.notify("llm.modelLoaded", { provider, modelName });
    return { isLoaded: true };
  }
  await ctx.registry.unloadModel(provider, modelName);
  ctx.notify("llm.modelUnloaded", { provider, modelName });
  return { isLoaded: false };
}

async function handleSetDefault(
  params: unknown,
  ctx: LlmRpcContext,
): Promise<{ taskType: string; provider: string; modelName: string }> {
  const p = params as { taskType?: string; provider?: string; modelName?: string } | null;
  if (
    p === null ||
    typeof p.taskType !== "string" ||
    !VALID_LLM_TASKS.has(p.taskType) ||
    typeof p.provider !== "string" ||
    !VALID_LLM_PROVIDERS.has(p.provider) ||
    typeof p.modelName !== "string"
  ) {
    throw new LlmRpcError(-32602, "setDefault requires valid taskType, provider, modelName");
  }
  await ctx.registry.setDefault(
    p.taskType as "classification" | "reasoning" | "summarisation" | "agent_step",
    p.provider as "ollama" | "llamacpp" | "remote",
    p.modelName,
  );
  return { taskType: p.taskType, provider: p.provider, modelName: p.modelName };
}

function handleCancelPull(params: unknown): { cancelled: boolean } {
  const p = params as { pullId?: string } | null;
  if (p === null || typeof p.pullId !== "string") {
    throw new LlmRpcError(-32602, "cancelPull requires pullId");
  }
  const controller = activePulls.get(p.pullId);
  const cancelled = controller !== undefined;
  controller?.abort();
  return { cancelled };
}

export async function dispatchLlmRpc(
  method: string,
  params: unknown,
  ctx: LlmRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<LlmRpcContext>(method, params, ctx, {
    "llm.listModels": async (_p, c) => ({ models: await c.registry.listAllModels() }),
    "llm.getStatus": async (_p, c) => ({ available: await c.registry.checkAvailability() }),
    "llm.status": async (_p, c) => ({ decisions: await c.registry.getRouterStatus() }),
    "llm.pullModel": handlePullModel,
    "llm.cancelPull": (p) => handleCancelPull(p),
    "llm.loadModel": (p, c) => handleLoadOrUnload("load", p, c),
    "llm.unloadModel": (p, c) => handleLoadOrUnload("unload", p, c),
    "llm.getRouterStatus": async (_p, c) => ({ decisions: await c.registry.getRouterStatus() }),
    "llm.setDefault": handleSetDefault,
  });
}
