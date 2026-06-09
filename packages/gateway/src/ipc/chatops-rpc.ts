import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export interface ChatopsPlatformStatus {
  readonly name: "slack" | "teams";
  readonly connected: boolean;
  readonly channels: number;
}

export interface ChatopsStatus {
  readonly enabled: boolean;
  readonly platforms: readonly ChatopsPlatformStatus[];
  readonly lastEventAt?: number;
}

export interface ChatopsRpcCtx {
  readonly status: () => ChatopsStatus;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly testParse: (text: string) => unknown;
}

function requireString(params: unknown, key: string): string {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string") throw new Error(`ERR_INVALID_PARAMS: ${key} (string) required`);
  return v;
}

const HANDLERS: RpcMethodHandlerMap<ChatopsRpcCtx> = {
  "chatops.status": (_p, ctx) => ctx.status(),
  "chatops.start": async (_p, ctx) => {
    await ctx.start();
    return { ok: true } as const;
  },
  "chatops.stop": async (_p, ctx) => {
    await ctx.stop();
    return { ok: true } as const;
  },
  "chatops.test": (p, ctx) => ctx.testParse(requireString(p, "text")),
} as const;

export function dispatchChatopsRpc(
  method: string,
  params: unknown,
  ctx: ChatopsRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
