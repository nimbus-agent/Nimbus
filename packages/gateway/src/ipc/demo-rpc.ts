import type { Database } from "bun:sqlite";

import { DemoSeedRefusedError, seedDemoCorpus } from "../demo/seed.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class DemoRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "DemoRpcError";
    this.rpcCode = rpcCode;
  }
}

export type DemoRpcContext = {
  readonly db: Database;
  readonly configDir: string;
  readonly dataDir: string;
  readonly now?: () => number;
};

function requireSeedParams(params: unknown): { nowMs?: number } {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new DemoRpcError(-32602, "ERR_INVALID_PARAMS: demo.seed takes { nowMs?: number }");
  }
  const rec = params as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return {};
  if (keys.length > 1 || !("nowMs" in rec)) {
    throw new DemoRpcError(-32602, "ERR_INVALID_PARAMS: demo.seed takes { nowMs?: number }");
  }
  const { nowMs } = rec;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs <= 0) {
    throw new DemoRpcError(-32602, "ERR_INVALID_PARAMS: demo.seed takes { nowMs?: number }");
  }
  return { nowMs };
}

async function handleDemoSeed(params: unknown, ctx: DemoRpcContext): Promise<unknown> {
  const p = requireSeedParams(params);
  const nowMs = p.nowMs ?? (ctx.now ?? Date.now)();
  try {
    return await seedDemoCorpus(ctx.db, {
      configDir: ctx.configDir,
      dataDir: ctx.dataDir,
      nowMs,
    });
  } catch (e) {
    if (e instanceof DemoSeedRefusedError) {
      throw new DemoRpcError(-32010, e.message);
    }
    throw e;
  }
}

/**
 * `demo.*` — I41 clause (5). The inner, pure dispatcher: reachable from a real gateway only
 * through `tryDispatchDemoRpc` (`ipc/server/dispatchers.ts`), which claims the namespace ONLY
 * when `ctx.options.demo === true` — see that function's own doc comment for why an ordinary
 * gateway never routes here at all.
 */
export async function dispatchDemoRpc(
  method: string,
  params: unknown,
  ctx: DemoRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<DemoRpcContext>(method, params, ctx, {
    "demo.seed": handleDemoSeed,
  });
}
