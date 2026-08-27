import type { LlmRegistry } from "../llm/registry.ts";
import type { RouteAvailability } from "../llm/route-availability.ts";
import { RouteAvailabilityProbe } from "../llm/route-availability.ts";
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

// Validity of a provider string is the registry's answer (`Provider not registered: …`), not a
// hardcoded set here — see `llm/router.ts` / `llm/registry.ts`, the one-definition-of-local-ness
// sites. This function only enforces shape: non-empty, defaulting to "ollama" when omitted.
function requireModelParams(
  params: unknown,
  action: string,
): { provider: string; modelName: string } {
  const p = params as { provider?: string; modelName?: string } | null;
  if (p === null || typeof p.modelName !== "string") {
    throw new LlmRpcError(-32602, `${action} requires modelName`);
  }
  const provider = p.provider ?? "ollama";
  if (typeof provider !== "string" || provider === "") {
    throw new LlmRpcError(-32602, `${action} requires a non-empty provider`);
  }
  return { provider, modelName: p.modelName };
}

export type LlmRouteStatus = {
  routeId: string;
  providerId: string;
  modelName: string;
  isLocal: boolean;
  available: boolean;
  reason: RouteAvailability["reason"];
  // Frequently undefined — the router's `meetsCapabilityFloor` fail-opens on exactly this gap.
  // Passed through as-is; never substitute a fabricated default.
  contextWindow?: number;
};

// One probe per call, not module-level: a status query should reflect current reality rather
// than a cache shared with unrelated callers (and, incidentally, with any other status query),
// and route lists are typically small enough that this costs little.
async function getRouteStatuses(ctx: LlmRpcContext): Promise<{ routes: LlmRouteStatus[] }> {
  const probe = new RouteAvailabilityProbe();
  const routes = ctx.registry.llmRouter.routes();
  const statuses = await Promise.all(
    routes.map(async (route): Promise<LlmRouteStatus> => {
      const { available, reason } = await probe.check(route);
      return {
        routeId: route.routeId,
        providerId: route.provider.providerId,
        modelName: route.modelName,
        isLocal: route.provider.isLocal,
        available,
        reason,
        ...(route.meta.contextWindow !== undefined
          ? { contextWindow: route.meta.contextWindow }
          : {}),
      };
    }),
  );
  return { routes: statuses };
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
    p.provider === "" ||
    typeof p.modelName !== "string"
  ) {
    throw new LlmRpcError(-32602, "setDefault requires valid taskType, provider, modelName");
  }
  await ctx.registry.setDefault(
    p.taskType as "classification" | "reasoning" | "summarisation" | "agent_step",
    p.provider,
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
    "llm.status": (_p, c) => getRouteStatuses(c),
    "llm.pullModel": handlePullModel,
    "llm.cancelPull": (p) => handleCancelPull(p),
    "llm.loadModel": (p, c) => handleLoadOrUnload("load", p, c),
    "llm.unloadModel": (p, c) => handleLoadOrUnload("unload", p, c),
    // llm.getRouterStatus is the pre-route-list per-task-decision payload, kept for
    // backwards compatibility with existing clients. llm.status now lists every registered
    // route with its own availability (see getRouteStatuses) — no longer "the same payload,
    // richer model data" as this comment used to claim; the two shapes have diverged.
    "llm.getRouterStatus": async (_p, c) => ({ decisions: await c.registry.getRouterStatus() }),
    "llm.setDefault": handleSetDefault,
  });
}
