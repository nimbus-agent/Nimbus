import { proposableWriteTool } from "../connectors/proposable-actions.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { bindConsentChannel, type ExecutorPolicyDep, ToolExecutor } from "../engine/executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "../engine/types.ts";
import { formatActionConsent } from "../mcp-sink/capture-act.ts";
import {
  acceptCapture,
  type CaptureCaller,
  type CaptureGateDeps,
  captureStateFor,
  captureStatus,
  getCapture,
  listCaptures,
  purgeCapture,
  rejectCapture,
  revokeCapture,
  submitCapture,
} from "../mcp-sink/capture-gate.ts";
import { type ActDeps, CaptureError } from "../mcp-sink/capture-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/**
 * `capture.*` (MCP-facing) and `captures.*` (owner-facing) — invariant I28. LAN-forbidden by
 * namespace (I5), no HTTP route; only `captures.list`/`captures.get` are on the Tauri allowlist
 * (I7), for the read-only desktop Captures page. The caller's kind comes
 * from the CONNECTION (`ServerCtx.getClientKind`), never from params.
 */
export interface CaptureRpcCtx {
  readonly gate: CaptureGateDeps;
  /** Absent → the act door cannot execute: an action accept refuses ERR_CAPTURE_DISABLED. */
  readonly act?: CaptureActWiring;
}

/**
 * What the act door executes WITH (spec § 3): the dispatcher runAsk and ChatOps use, the real egress
 * sink (I29) and the policy overlay (I22). Built once in platform/assemble.ts; the executor itself
 * is built per accept, around the ACCEPTING session's consent channel.
 */
export interface CaptureActWiring {
  readonly dispatcher: ConnectorDispatcher;
  readonly egressSink: EgressSink;
  readonly audit: AuditSink;
  readonly policyHitl: ExecutorPolicyDep;
}

/**
 * Replace the executor's generic prompt with the provenance prompt (spec § 8 step 7). The details
 * are UNREDACTED on purpose: the owner approves the exact input that will be dispatched, and the
 * consent channel goes only to the accepting local session. The audit row stays redacted — the
 * executor's `auditPayload` is untouched.
 */
function provenanceConsent(
  inner: ConsentChannel,
  prompt: string,
  details: Record<string, unknown>,
): ConsentChannel {
  return {
    requestApproval: (_prompt, _details, actionType) =>
      inner.requestApproval(prompt, details, actionType),
  };
}

/**
 * The act door's executor seam (I28 + I2/I29/I22/I42): one fresh `ToolExecutor` per accept, bound
 * to the ACCEPTING session's consent channel, with NO delegate (the local owner answers).
 */
export function buildActDeps(
  w: CaptureActWiring,
  coordinator: ConsentCoordinator,
  clientId: string,
): ActDeps {
  return {
    async execute(actionType, input, provenance) {
      // The tool is ALWAYS gateway-chosen: the routing table for a first-party type, the canonical
      // `<serviceId>_<tool>` key for a user-MCP type (the exact pair `connector.userMcpCall` builds,
      // and the only key the dispatcher's I42 pairing accepts for that type). The second lookup
      // returns undefined for anything that is not an `mcp_*` type.
      const toolId = proposableWriteTool(actionType) ?? userMcpToolKeyForActionType(actionType);
      if (toolId === undefined) {
        // Never dispatch a first-party write by its type (spec § 6.3): no routing row, no call.
        // This exact message is what classifyActionError maps to ERR_ACTION_TOOL_NOT_FOUND.
        throw new Error("Tool not found");
      }
      const consent = provenanceConsent(
        bindConsentChannel(coordinator, clientId),
        formatActionConsent(provenance, actionType, input),
        { actionType, input },
      );
      // I20/I42: no delegate — the LOCAL owner who ran `captures accept` answers.
      const executor = new ToolExecutor(
        consent,
        w.audit,
        w.dispatcher,
        undefined,
        w.egressSink,
        w.policyHitl,
      );
      const out = await executor.execute({
        type: actionType,
        payload: { mcpToolId: toolId, input },
      });
      return out.status === "ok" ? { status: "ok", result: out.result } : { status: "rejected" };
    },
  };
}

type Ctx = { readonly gate: CaptureGateDeps; readonly caller: CaptureCaller };

function idParam(params: unknown): unknown {
  return typeof params === "object" && params !== null
    ? (params as Record<string, unknown>)["id"]
    : undefined;
}

export async function dispatchCaptureRpc(
  method: string,
  params: unknown,
  ctx: CaptureRpcCtx,
  caller: CaptureCaller,
  consent?: ConsentCoordinator,
): Promise<RpcMissOrHit> {
  try {
    return await dispatchByMethod<Ctx, unknown>(
      method,
      params,
      { gate: ctx.gate, caller },
      {
        "capture.status": (_p, c) => captureStatus(c.gate),
        "capture.state": (p, c) => captureStateFor(c.gate, c.caller, idParam(p)),
        "capture.submit": (p, c) => submitCapture(c.gate, c.caller, p),
        "captures.list": (p, c) => listCaptures(c.gate, c.caller, p),
        "captures.get": (p, c) => getCapture(c.gate, c.caller, idParam(p)),
        "captures.revoke": (p, c) => revokeCapture(c.gate, c.caller, idParam(p)),
        // Always awaited by dispatchByMethod: an action accept returns a Promise.
        "captures.accept": (p, c) =>
          acceptCapture(
            c.gate,
            c.caller,
            idParam(p),
            ctx.act !== undefined && consent !== undefined
              ? buildActDeps(ctx.act, consent, c.caller.clientId)
              : undefined,
          ),
        "captures.reject": (p, c) => rejectCapture(c.gate, c.caller, idParam(p)),
        "captures.purge": (p, c) => purgeCapture(c.gate, c.caller, idParam(p)),
      },
    );
  } catch (e) {
    if (e instanceof CaptureError) throw new RpcMethodError(-32001, e.message, { code: e.code });
    throw e;
  }
}
