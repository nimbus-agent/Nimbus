import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export interface TribalStatus {
  readonly enabled: boolean;
  readonly clusters: number;
}

export interface TribalCaptureResult {
  ok: boolean;
  pageRef?: string;
  error?: string;
}

/**
 * Submits the capture action through the executor HITL gate. Built PER-CALL in the dispatcher with
 * the initiating client's consent channel (the local owner who ran `nimbus tribal capture`) — never
 * at boot — so the I25 approval prompt reaches the operator who triggered it.
 */
export type TribalSubmitAction = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<{ status: "approved" | "rejected"; result?: { pageRef: string } }>;

export interface TribalRpcCtx {
  readonly status: () => TribalStatus;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly list: (status?: string) => unknown;
  readonly dismiss: (clusterId: string) => Promise<void>;
  readonly scan: () => Promise<{ scanned: number; fired: number }>;
  /** `submitAction` is supplied per-call by the dispatcher (per-client HITL consent); see I25. */
  readonly capture: (
    clusterId: string,
    target: string | undefined,
    submitAction: TribalSubmitAction,
  ) => Promise<TribalCaptureResult>;
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
  // NOTE: `tribal.capture` is NOT registered here — it needs a per-call HITL consent channel
  // (the initiating client) that only the dispatcher has. See tryDispatchTribalRpc.
} as const;

export function dispatchTribalRpc(
  method: string,
  params: unknown,
  ctx: TribalRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
