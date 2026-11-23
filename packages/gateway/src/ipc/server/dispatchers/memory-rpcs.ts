import { dispatchMemoryRpc, MemoryRpcError } from "../../memory-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

/**
 * `memory.*` (Phase 10, owner ruling OR-S4-MEM, I61): the owner's list and forget of long-term episodic memory.
 * Served only to a connection that declared `cli` or `ui` (the CONNECTION's kind, never a param); LAN-forbidden
 * (I5) and absent from the Tauri allowlist (I7). The memory is the one the boot wiring attached to the session
 * store; a demo gateway has none, so both methods refuse there.
 */
export async function tryDispatchMemoryRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("memory.")) return phase4RpcSkipped;
  try {
    const out = await dispatchMemoryRpc(
      method,
      params,
      { memory: () => ctx.options.sessionMemoryStore?.episodic },
      { kind: ctx.getClientKind(clientId) },
    );
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof MemoryRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
