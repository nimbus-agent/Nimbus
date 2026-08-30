import { setNimbusTomlSectionKey } from "../config/toml-section-writer.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { RouteAvailability } from "../llm/route-availability.ts";
import { makeRouteId } from "../llm/route-id.ts";
import type { LlmTaskType, ProviderId } from "../llm/types.ts";
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
  /**
   * The resolved `nimbus.toml` path (`resolveNimbusTomlForProfile(configDir)`), needed only
   * by `llm.use`, which is the one handler in this file that WRITES config rather than just
   * reading the registry. Optional so every other handler's test fixture — none of which
   * needs it — stays unchanged; `handleLlmUse` throws a clear error if it is missing rather
   * than writing to an undefined path.
   */
  tomlPath?: string;
};

const activePulls = new Map<string, AbortController>();

const VALID_LLM_TASKS = new Set(["classification", "reasoning", "summarisation", "agent_step"]);

/**
 * Narrows `params` to a plain object BEFORE any field is read.
 *
 * The cast this replaces (`params as { … } | null`) was a lie for exactly one input: an OMITTED
 * `params` member. JSON-RPC allows it, `p` was then `undefined`, and the very next line —
 * `typeof p.modelName` — threw a raw `TypeError`. Only `LlmRpcError` is mapped to the intended
 * `-32602 Invalid params`, so a request that merely forgot its arguments surfaced as an internal
 * error. `typeof null === "object"`, hence the explicit null check; arrays are rejected too,
 * since none of these handlers takes positional params.
 */
function requireParamsObject(params: unknown, message: string): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new LlmRpcError(-32602, message);
  }
  return params as Record<string, unknown>;
}

// Validity of a provider string is the registry's answer (`Provider not registered: …`), not a
// hardcoded set here — see `llm/router.ts` / `llm/registry.ts`, the one-definition-of-local-ness
// sites. This function only enforces shape: non-empty, defaulting to "ollama" when omitted.
// `routeId` is the OPTIONAL discriminator `LlmRegistry`'s lifecycle calls use when one vendor id
// has several daemons behind it; omitted (the normal case) the registry resolves the single
// instance, and throws naming the candidates rather than guessing when there is more than one.
function requireModelParams(
  params: unknown,
  action: string,
): { provider: string; modelName: string; routeId?: string } {
  const p = requireParamsObject(params, `${action} requires modelName`);
  if (typeof p["modelName"] !== "string") {
    throw new LlmRpcError(-32602, `${action} requires modelName`);
  }
  const provider = p["provider"] ?? "ollama";
  if (typeof provider !== "string" || provider === "") {
    throw new LlmRpcError(-32602, `${action} requires a non-empty provider`);
  }
  const routeIdRaw = p["routeId"];
  if (routeIdRaw !== undefined && (typeof routeIdRaw !== "string" || routeIdRaw === "")) {
    throw new LlmRpcError(-32602, `${action} routeId must be a non-empty string when present`);
  }
  return {
    provider,
    modelName: p["modelName"],
    ...(routeIdRaw === undefined ? {} : { routeId: routeIdRaw }),
  };
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

// Availability comes from the REGISTRY-owned probe (`registry.checkRoute`), never one
// constructed here. A fresh probe per call sounded like "current reality" but was the opposite:
// it answered from a cache no other caller shares, so `llm.status` could report a route
// available while the router — walking its own shared probe — had already routed past it, and
// nothing could reconcile the two snapshots. One probe, one answer.
async function getRouteStatuses(ctx: LlmRpcContext): Promise<{ routes: LlmRouteStatus[] }> {
  const routes = ctx.registry.llmRouter.routes();
  const statuses = await Promise.all(
    routes.map(async (route): Promise<LlmRouteStatus> => {
      const { available, reason } = await ctx.registry.checkRoute(route);
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
  const { provider, modelName, routeId } = requireModelParams(params, "pullModel");
  const pullId = `pull_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  activePulls.set(pullId, controller);
  void ctx.registry
    .pullModel(provider, modelName, {
      signal: controller.signal,
      onProgress: (c) => ctx.notify("llm.pullProgress", { pullId, provider, modelName, ...c }),
      ...(routeId === undefined ? {} : { routeId }),
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
  const { provider, modelName, routeId } = requireModelParams(params, `${action}Model`);
  const target = routeId === undefined ? {} : { routeId };
  if (action === "load") {
    await ctx.registry.loadModel(provider, modelName, target);
    ctx.notify("llm.modelLoaded", { provider, modelName });
    return { isLoaded: true };
  }
  await ctx.registry.unloadModel(provider, modelName, target);
  ctx.notify("llm.modelUnloaded", { provider, modelName });
  return { isLoaded: false };
}

/**
 * Pin a task to a route, from the desktop UI's `(taskType, provider, modelName)` shape.
 *
 * This endpoint used to be WRITE-ONLY (#1383): it persisted to `llm_task_defaults` (V20) and
 * NOTHING read that table, so the control appeared to work and changed nothing about routing.
 * It now writes the same store `llm.use` writes — `[llm.tasks]` — which is what
 * `parseLlmTaskPins` reads at boot and what `LlmRouter` honours at runtime.
 *
 * The wire shape is deliberately unchanged: this method is renderer-exposed and the desktop UI
 * calls it. Only the destination moved. `provider` + `modelName` are joined by `makeRouteId`,
 * which is the same function `registerRoute` uses to mint the id, so the two cannot drift.
 *
 * Fail-CLOSED on both an unknown task and an unregistered route, matching `handleLlmUse` below.
 * The open question #1383 recorded — what should happen with no writable config path — is
 * answered the same way that handler already answers it: refuse. A silent success that persists
 * nothing is exactly the bug this change removes.
 */
async function handleSetDefault(
  params: unknown,
  ctx: LlmRpcContext,
): Promise<{ taskType: string; provider: string; modelName: string }> {
  const message = "setDefault requires valid taskType, provider, modelName";
  const p = requireParamsObject(params, message);
  const taskType = p["taskType"];
  const provider = p["provider"];
  const modelName = p["modelName"];
  if (
    typeof taskType !== "string" ||
    !VALID_LLM_TASKS.has(taskType) ||
    typeof provider !== "string" ||
    provider === "" ||
    typeof modelName !== "string" ||
    modelName === ""
  ) {
    throw new LlmRpcError(-32602, message);
  }
  const routeId = makeRouteId(provider as ProviderId, modelName);
  if (ctx.registry.llmRouter.routeFor(routeId) === undefined) {
    const known = ctx.registry.llmRouter
      .routes()
      .map((r) => r.routeId)
      .join(", ");
    throw new LlmRpcError(-32602, `"${routeId}" is not a registered route. Registered: ${known}`);
  }
  if (ctx.tomlPath === undefined) {
    throw new LlmRpcError(-32603, "llm.setDefault requires a configured configDir");
  }
  setNimbusTomlSectionKey(ctx.tomlPath, "[llm.tasks]", taskType, routeId);
  ctx.registry.llmRouter.setTaskPin(taskType as LlmTaskType, routeId);
  return { taskType, provider, modelName };
}

/**
 * Pins a task type to a specific route id (`nimbus llm use <task> <routeId>`) — the ONLY
 * writer of `[llm.tasks]` other than a human hand-editing `nimbus.toml`, and the same table
 * Task 5's parser reads and Task 6's router honours. Deliberately GATEWAY-side rather than
 * CLI-side: the gateway is what owns `nimbus.toml` and what knows which routes are currently
 * registered, so validating and writing here — in one process, one call — closes the window
 * a CLI-validates/CLI-writes split would leave between the two.
 *
 * Fail-CLOSED on both checks, deliberately unlike the router's own fail-open on a stale pin
 * at READ time (`LlmRouter.orderedRoutes`): writing an unresolvable task or route id would
 * persist a pin that silently never applies — the orphaned-config shape this whole plan
 * exists to stop repeating. Nothing is written to `nimbus.toml` unless both checks pass.
 */
async function handleLlmUse(params: unknown, ctx: LlmRpcContext): Promise<{ ok: true }> {
  const p = requireParamsObject(params, "llm.use requires task and routeId");
  const task = p["task"];
  const routeId = p["routeId"];
  if (typeof task !== "string" || !VALID_LLM_TASKS.has(task)) {
    throw new LlmRpcError(
      -32602,
      `Unknown task type "${String(task)}". Expected one of: ${[...VALID_LLM_TASKS].join(", ")}.`,
    );
  }
  if (typeof routeId !== "string" || ctx.registry.llmRouter.routeFor(routeId) === undefined) {
    const known = ctx.registry.llmRouter
      .routes()
      .map((r) => r.routeId)
      .join(", ");
    throw new LlmRpcError(
      -32602,
      `"${String(routeId)}" is not a registered route. Registered: ${known}`,
    );
  }
  if (ctx.tomlPath === undefined) {
    throw new LlmRpcError(-32603, "llm.use requires a configured configDir");
  }
  setNimbusTomlSectionKey(ctx.tomlPath, "[llm.tasks]", task, routeId);
  ctx.registry.llmRouter.setTaskPin(task as LlmTaskType, routeId);
  return { ok: true };
}

function handleCancelPull(params: unknown): { cancelled: boolean } {
  const p = requireParamsObject(params, "cancelPull requires pullId");
  const pullId = p["pullId"];
  if (typeof pullId !== "string") {
    throw new LlmRpcError(-32602, "cancelPull requires pullId");
  }
  const controller = activePulls.get(pullId);
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
    "llm.use": handleLlmUse,
  });
}
