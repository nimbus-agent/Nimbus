import { NULL_EGRESS_SINK } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import type { ConnectorDispatcher } from "../../../engine/types.ts";
import { buildStatus } from "../../admin-status-rpc.ts";
import { dispatchClipRpc } from "../../clip-rpc.ts";
import {
  DecisionsRpcError,
  dispatchDecisionsRpc,
  handleDecisionsStatus,
} from "../../decisions-rpc.ts";
import { dispatchEgressRpc, type EgressRpcCtx, EgressRpcError } from "../../egress-rpc.ts";
import { dispatchGlossaryRpc, GlossaryRpcError } from "../../glossary-rpc.ts";
import { dispatchOwnershipRpc } from "../../ownership-rpc.ts";
import { dispatchPremortemRpc, PremortemRpcError } from "../../premortem-rpc.ts";
import { dispatchShareRpc, ShareRpcError } from "../../share-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

export async function tryDispatchShareRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("share.")) return phase4RpcSkipped;
  const rpc = ctx.options.shareRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchShareRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ShareRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchEgressRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("egress.")) return phase4RpcSkipped;
  const base = ctx.options.egressRpcCtx;
  if (base === undefined) return phase4RpcSkipped;
  // I2: bind `egress.prune` (the sole mutation, in the HITL frozen set) to the LOCAL owner's consent
  // gate via the calling client's channel — the teamvault.put/delete pattern. A gate-only stub
  // executor (no egress sink: prune is a local mutation, NOT outbound) prompts the owner; deny /
  // disconnect → not approved → nothing pruned. The assemble-built default is fail-closed.
  const rpc: EgressRpcCtx =
    method === "egress.prune" && ctx.options.localIndex !== undefined
      ? { ...base, requestPruneApproval: makePruneApproval(ctx, clientId) }
      : base;
  try {
    const out = await dispatchEgressRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof EgressRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchGlossaryRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("glossary.")) return phase4RpcSkipped;
  const refresher = ctx.options.glossaryRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchGlossaryRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof GlossaryRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchDecisionsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("decisions.")) return phase4RpcSkipped;
  const refresher = ctx.options.decisionsRefresher;
  // Answered with or without a refresher: a disabled pass reports `enabled: false` rather than
  // looking like a method that does not exist.
  if (method === "decisions.status") {
    const localIndex = ctx.options.localIndex;
    if (localIndex === undefined) {
      throw new RpcMethodError(-32603, "decisions.status requires LocalIndex");
    }
    try {
      return handleDecisionsStatus(params, {
        db: localIndex.getDatabase(),
        configDir: ctx.options.configDir,
        refresher,
        nowMs: () => Date.now(),
      });
    } catch (e) {
      if (e instanceof DecisionsRpcError) throw new RpcMethodError(e.rpcCode, e.message);
      throw e;
    }
  }
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchDecisionsRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DecisionsRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * Unlike decisions/glossary/ownership, this dispatcher does NOT skip cleanly when
 * `ctx.options.premortemRefresher` is unset — it always calls `dispatchPremortemRpc`, which
 * throws an explicit `ERR_PREMORTEM_DISABLED` in that case. A `premortem.refresh` call must
 * fail loudly when `[premortem].enabled = false`, not surface as a generic "Method not found"
 * one level up: a silent miss here would look identical to the method never having existed,
 * which is not the honest answer for "this subsystem is switched off".
 */
export async function tryDispatchPremortemRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("premortem.")) return phase4RpcSkipped;
  try {
    const out = await dispatchPremortemRpc(method, params, {
      ...(ctx.options.premortemRefresher === undefined
        ? {}
        : { premortemRefresher: ctx.options.premortemRefresher }),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof PremortemRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

export async function tryDispatchOwnershipRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("ownership.")) return phase4RpcSkipped;
  const refresher = ctx.options.ownershipRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  // Unlike glossary/decisions, there is no try/catch + <X>RpcError remap here: the sole
  // handler (`ownership.refresh` → `startPass` → `LongRunningJobRegistry.start()`) always
  // returns `{ jobId }` synchronously and never throws — there is no rebuild verb and no
  // params to validate, so `dispatchOwnershipRpc` cannot reject before returning a "hit" or
  // "miss". A try/catch around an await that can never reject is dead code, not defense.
  const out = await dispatchOwnershipRpc(method, params, {
    refresher,
    notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
  });
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}

/** Owner-HITL approval for `egress.prune`, gated through the calling client's consent channel. */
function makePruneApproval(
  ctx: ServerCtx,
  clientId: string,
): (beforeTs: number) => Promise<boolean> {
  return async (beforeTs) => {
    const index = ctx.options.localIndex;
    if (index === undefined) return false;
    const stubDispatcher: ConnectorDispatcher = {
      dispatch(): Promise<unknown> {
        return Promise.reject(new Error("egress prune gate does not dispatch to MCP"));
      },
    };
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
    const executor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      index,
      stubDispatcher,
      undefined,
      NULL_EGRESS_SINK,
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    const gate = await executor.gate({ type: "egress.prune", payload: { beforeTs } });
    return gate === "proceed";
  };
}

export function tryDispatchAdminRpc(ctx: ServerCtx, method: string, _params: unknown): unknown {
  if (method !== "admin.status" || ctx.options.statusReaders === undefined) {
    return phase4RpcSkipped;
  }
  return buildStatus(ctx.options.statusReaders);
}

export async function tryDispatchClipRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("clip.") || ctx.options.clipPairingController === undefined) {
    return phase4RpcSkipped;
  }
  const out = await dispatchClipRpc(method, params, {
    pairing: ctx.options.clipPairingController,
    vault: ctx.options.vault,
    ...(ctx.options.localIndex === undefined ? {} : { db: ctx.options.localIndex.getDatabase() }),
    ...(ctx.options.clipHttpBaseUrl === undefined
      ? {}
      : { httpBaseUrl: ctx.options.clipHttpBaseUrl }),
    briefsEnabled: ctx.options.briefsEnabled ?? false,
  });
  if (out.kind === "hit") return out.value;
  throw new RpcMethodError(-32601, `Method not found: ${method}`);
}
