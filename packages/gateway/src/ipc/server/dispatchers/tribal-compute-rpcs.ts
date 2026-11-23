import { asRecord } from "../../../connectors/unknown-record.ts";
import { makeEgressSink } from "../../../egress/egress-ledger.ts";
import { bindConsentChannel, NO_POLICY_OVERLAY, ToolExecutor } from "../../../engine/executor.ts";
import { ComputerRpcError, dispatchComputerRpc } from "../../computer-rpc.ts";
import { dispatchExecRpc, ExecRpcError } from "../../exec-rpc.ts";
import { dispatchFleetRpc, FleetRpcError } from "../../fleet-rpc.ts";
import { dispatchToolgenRpc, ToolgenRpcError } from "../../toolgen-rpc.ts";
import { dispatchTribalRpc } from "../../tribal-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

function tribalParamString(params: unknown, key: string): string | undefined {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Extract a stable pageRef (`notion:<id>` / `confluence:<id>`) from a KB-append connector result.
 * The result is the MCP tool envelope wrapping the created page JSON; tolerant of shapes, returns
 * "" if no id is found (→ the write-gate reports write_failed, never a false success).
 */
/** Recursively dig a page `id` out of a KB-append result envelope (top-level or nested in JSON text). */
function findKbPageId(v: unknown): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  if (typeof rec["id"] === "string") return rec["id"];
  const content = rec["content"];
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    const id = findKbPageIdInText(text);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Parse a content-block's text as JSON and recurse; non-JSON text yields no id. */
function findKbPageIdInText(text: string): string | undefined {
  try {
    return findKbPageId(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function extractKbPageRef(actionType: string, result: unknown): string {
  const prefix = actionType.startsWith("notion") ? "notion" : "confluence";
  const id = findKbPageId(result);
  return id === undefined ? "" : `${prefix}:${id}`;
}

export async function tryDispatchTribalRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("tribal.")) return phase4RpcSkipped;
  const rpc = ctx.options.tribalRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;

  // I25: capture is special-cased — it needs a per-call HITL consent channel bound to the
  // initiating client (the local owner who ran `nimbus tribal capture`), which only the dispatcher
  // has. The submitAction runs the KB write through the executor gate; the destination comes from
  // local config inside the write-gate, never from these params.
  if (method === "tribal.capture") {
    const clusterId = tribalParamString(params, "clusterId");
    if (clusterId === undefined || clusterId === "") {
      throw new RpcMethodError(-32602, "ERR_INVALID_PARAMS: clusterId (string) required");
    }
    const target = tribalParamString(params, "target");
    const dispatcher = ctx.options.tribalConnectorDispatcher;
    const index = ctx.options.localIndex;
    if (dispatcher === undefined || index === undefined) {
      return rpc.capture(clusterId, target, () => Promise.resolve({ status: "rejected" }));
    }
    // I29: tribal capture dispatches a real connector write (notion/confluence KB append) — an
    // outbound event — so this executor carries the egress sink (append-before-dispatch).
    const executor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      index,
      dispatcher,
      undefined,
      makeEgressSink(index.getDatabase()),
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
    return rpc.capture(clusterId, target, async (action) => {
      const result = await executor.execute({ type: action.type, payload: action.payload });
      if (result.status !== "ok") return { status: "rejected" };
      return {
        status: "approved",
        result: { pageRef: extractKbPageRef(action.type, result.result) },
      };
    });
  }

  const out = await dispatchTribalRpc(method, params, rpc);
  if (out.kind === "hit") return out.value;
  return phase4RpcSkipped;
}

/**
 * Share & Virality (Phase 6 Slice 8). The 3-arg form (no per-client `clientId`): share's HITL is the
 * broadcast consent broker (a prompt to ALL connected clients answered by the local owner), NOT a
 * per-client `ToolExecutor` channel like tribal.capture. So every share.* method (incl. share.create)
 * lives in the HANDLERS map and is dispatched here uniformly.
 */
/**
 * Sandboxed code execution (Spine S2 slice 1, invariant I33). Like share, the 3-arg form: the HITL
 * here is the broadcast consent broker answered by the local owner, not a per-client `ToolExecutor`
 * channel. Present only when assembled at boot, so the dispatcher skips cleanly when the capability
 * is not wired. `exec.run` is RCE-class and is NOT Tauri-exposed (I7).
 */
export async function tryDispatchExecRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("exec.")) return phase4RpcSkipped;
  const rpc = ctx.options.execRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchExecRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ExecRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * S2 runtime tool generation (invariant I39). Same 3-arg shape as exec: the HITL here is the
 * broadcast consent broker answered by the local owner, not a per-client `ToolExecutor` channel.
 * Present only when assembled at boot, so the dispatcher skips cleanly when the capability is not
 * wired. `toolgen.create` is RCE-class (it registers model-authored code that then runs) and is
 * NOT Tauri-exposed (I7) — do not add `toolgen.*` to `ALLOWED_METHODS` in
 * `ui/src-tauri/src/gateway_bridge.rs`.
 */
export async function tryDispatchToolgenRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("toolgen.")) return phase4RpcSkipped;
  const rpc = ctx.options.toolgenRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchToolgenRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ToolgenRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * Computer-use browser lane (Spine S2 slice 2, invariant I35). Same 3-arg shape as exec: the
 * HITL here is the two broadcast consent brokers (envelope-open + per-action) answered by the
 * local owner, not a per-client `ToolExecutor` channel. Present only when assembled at boot, so
 * the dispatcher skips cleanly when the capability is not wired. The whole namespace is RCE-class
 * and is NOT Tauri-exposed (I7).
 */
export async function tryDispatchComputerRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("computer.")) return phase4RpcSkipped;
  const rpc = ctx.options.computerRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    // The calling connection: its prompts go to it alone, and only its answer counts (I35, OR-MCU-2).
    const out = await dispatchComputerRpc(method, params, rpc, clientId);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof ComputerRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}

/**
 * Overnight agent fleet (S2). Same 3-arg shape as exec/computer: the HITL boundary here is
 * `[fleet] enabled` + the `agent_fleet` org-policy lockoff (I22) checked inside `runOnce` itself,
 * not a per-client consent broker — an unattended overnight run has no client present to consent
 * per-action. Present only when assembled at boot; the dispatcher skips cleanly when unset.
 * `fleet.*` is LAN-forbidden in full (`FORBIDDEN_OVER_LAN`, I5). Only `fleet.briefs` and
 * `fleet.show` are on the Tauri allowlist (I7): they return stored local SQLite text the renderer
 * could already regenerate through the `agents.*` reads it holds, so they widen nothing.
 * `fleet.runNow` spends the machine's resources, and `fleet.digest`/`status`/`list` are terminal
 * surfaces, so none of those is renderer-callable.
 */
export async function tryDispatchFleetRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("fleet.")) return phase4RpcSkipped;
  const rpc = ctx.options.fleetRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchFleetRpc(method, params, rpc);
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof FleetRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
