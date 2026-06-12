import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export interface TribalStatus {
  readonly enabled: boolean;
  readonly clusters: number;
}

export interface TribalRpcCtx {
  readonly status: () => TribalStatus;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly list: (status?: string) => unknown;
  readonly dismiss: (clusterId: string) => Promise<void>;
  readonly scan: () => Promise<{ scanned: number; fired: number }>;
}

function requireString(params: unknown, key: string): string {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string") throw new Error(`ERR_INVALID_PARAMS: ${key} (string) required`);
  return v;
}

function optionalString(params: unknown, key: string): string | undefined {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  return typeof v === "string" ? v : undefined;
}

const HANDLERS: RpcMethodHandlerMap<TribalRpcCtx> = {
  "tribal.status": (_p, ctx) => ctx.status(),
  "tribal.start": async (_p, ctx) => {
    await ctx.start();
    return { ok: true } as const;
  },
  "tribal.stop": async (_p, ctx) => {
    await ctx.stop();
    return { ok: true } as const;
  },
  "tribal.list": (p, ctx) => ctx.list(optionalString(p, "status")),
  "tribal.dismiss": async (p, ctx) => {
    await ctx.dismiss(requireString(p, "clusterId"));
    return { ok: true } as const;
  },
  "tribal.scan": (_p, ctx) => ctx.scan(),
} as const;

export function dispatchTribalRpc(
  method: string,
  params: unknown,
  ctx: TribalRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
