import { bindConsentChannel, HITL_REQUIRED } from "../../../engine/executor.ts";
import { isStandingApprovalsEnabled } from "../../../standing/standing-rule-capability.ts";
import { dispatchApprovalsRpc } from "../../approvals-rpc.ts";
import { dispatchCaptureRpc } from "../../capture-rpc.ts";
import { createStandingOwnerAsk, dispatchStandingRpc } from "../../standing-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";

/**
 * `capture.*` / `captures.*` (MCP capture sink, I28). LAN-forbidden (I5); only `captures.list` and
 * `captures.get` are on the Tauri allowlist (I7), for the read-only desktop Captures page. The
 * caller's kind is the CONNECTION's, never a param.
 */
export async function tryDispatchCaptureRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("capture.") && !method.startsWith("captures.")) return phase4RpcSkipped;
  const rpc = ctx.options.captureRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  // The consent coordinator lets an action accept prompt THIS (the accepting) session (I28 act door).
  const out = await dispatchCaptureRpc(
    method,
    params,
    rpc,
    { clientId, kind: ctx.getClientKind(clientId) },
    ctx.consentImpl,
  );
  return out.kind === "hit" ? out.value : phase4RpcSkipped;
}

/**
 * `approvals.*` (Phase 28 AD2): the owner's queue of agent proposals and the one-step approval.
 * LAN-forbidden (I5), not on the Tauri allowlist (I7). The connection's kind is the CONNECTION's
 * (`getClientKind`), never a param; only a connection that declared `cli` or `ui` is served.
 */
export async function tryDispatchApprovalsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("approvals.")) return phase4RpcSkipped;
  const rpc = ctx.options.captureRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  const out = await dispatchApprovalsRpc(
    method,
    params,
    rpc,
    { clientId, kind: ctx.getClientKind(clientId) },
    ctx.consentImpl,
  );
  return out.kind === "hit" ? out.value : phase4RpcSkipped;
}

/**
 * `standing.*` (Phase 10 SA3, I55): the owner's standing approval rules. The whole namespace is in
 * `FORBIDDEN_OVER_LAN` (I5); the Tauri allowlist (I7) names list / show / fires / pause / revoke
 * only. The connection's kind is the CONNECTION's (`getClientKind`), never a param: `create` and
 * `resume` answer only a `cli` connection, and ask the LOCAL owner through an executor built with
 * no delegation, on THIS connection's consent channel.
 */
export async function tryDispatchStandingRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("standing.")) return phase4RpcSkipped;
  const localIndex = ctx.options.localIndex;
  if (localIndex === undefined) return phase4RpcSkipped;
  const db = localIndex.getDatabase();
  const out = await dispatchStandingRpc(method, params, {
    db,
    callerKind: ctx.getClientKind(clientId),
    // Fail closed: an absent policy accessor reads as locked off.
    policyAllows: () => isStandingApprovalsEnabled(ctx.options.enforcedPolicy?.()),
    askOwner: createStandingOwnerAsk({
      consent: bindConsentChannel(ctx.consentImpl, clientId),
      audit: localIndex,
      policyHitl: ctx.options.policyHitl,
    }),
    recordNarrowing: (actionType, actionJson) =>
      localIndex.recordAudit({
        actionType,
        hitlStatus: "not_required",
        actionJson,
        timestamp: Date.now(),
      }),
    frozenHitl: (t) => HITL_REQUIRED.has(t),
  });
  return out.kind === "hit" ? out.value : phase4RpcSkipped;
}
