import { dispatchSchedulingRpc, SchedulingRpcError } from "../../scheduling-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

/**
 * `scheduling.*` (Phase 10, OR-S4-SCHED, I17 (b)): the owner's federated-scheduling entry points.
 * LAN-forbidden by namespace (I5), not on the Tauri allowlist (I7). The connection's kind is the
 * CONNECTION's (`getClientKind`), never a param; only a connection that declared `cli` or `ui` is
 * served. Needs the federation asker deps, so it is skipped when federation is not booted.
 */
export async function tryDispatchSchedulingRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("scheduling.")) return phase4RpcSkipped;
  const index = ctx.options.localIndex;
  if (index === undefined || ctx.options.federationPairing === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchSchedulingRpc(method, params, {
      index,
      selfIdentity: ctx.options.federationIdentity,
      consentTimeoutMs: (ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000 + 5000,
      callerKind: ctx.getClientKind(clientId),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof SchedulingRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
