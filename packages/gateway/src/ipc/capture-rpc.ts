import {
  acceptCapture,
  type CaptureCaller,
  type CaptureGateDeps,
  captureStatus,
  getCapture,
  listCaptures,
  rejectCapture,
  revokeCapture,
  submitCapture,
} from "../mcp-sink/capture-gate.ts";
import { CaptureError } from "../mcp-sink/capture-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/**
 * `capture.*` (MCP-facing) and `captures.*` (owner-facing) — invariant I28. LAN-forbidden by
 * namespace (I5), absent from the Tauri allowlist (I7), no HTTP route. The caller's kind comes
 * from the CONNECTION (`ServerCtx.getClientKind`), never from params.
 */
export interface CaptureRpcCtx {
  readonly gate: CaptureGateDeps;
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
): Promise<RpcMissOrHit> {
  try {
    return await dispatchByMethod<Ctx, unknown>(
      method,
      params,
      { gate: ctx.gate, caller },
      {
        "capture.status": (_p, c) => captureStatus(c.gate),
        "capture.submit": (p, c) => submitCapture(c.gate, c.caller, p),
        "captures.list": (p, c) => listCaptures(c.gate, c.caller, p),
        "captures.get": (p, c) => getCapture(c.gate, c.caller, idParam(p)),
        "captures.revoke": (p, c) => revokeCapture(c.gate, c.caller, idParam(p)),
        "captures.accept": (p, c) => acceptCapture(c.gate, c.caller, idParam(p)),
        "captures.reject": (p, c) => rejectCapture(c.gate, c.caller, idParam(p)),
      },
    );
  } catch (e) {
    if (e instanceof CaptureError) throw new RpcMethodError(-32001, e.message, { code: e.code });
    throw e;
  }
}
