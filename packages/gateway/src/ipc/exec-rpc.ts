import { asRecord } from "../connectors/unknown-record.ts";
import type { ExecConsentBroker } from "../exec/exec-consent-broker.ts";
import { type ExecGateDeps, type RunExecutionRequest, runExecution } from "../exec/exec-gate.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";
import { requireNonEmptyStringParam, stringArrayAllOrNothing } from "./rpc-params.ts";

/** An `ExecRpcError` carries the JSON-RPC error code surfaced by the dispatcher chain. */
export class ExecRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ExecRpcError";
  }
}

export interface ExecRpcCtx {
  /** Everything `runExecution` needs; assembled once at boot. */
  readonly gateDeps: ExecGateDeps;
  /** The owner-approval broker this surface answers into. */
  readonly consent: ExecConsentBroker;
}

/** `ERR_INVALID_PARAMS: <key> (non-empty string) required`, as an `ExecRpcError`. */
function requireString(params: unknown, key: string): string {
  return requireNonEmptyStringParam(params, key, ExecRpcError);
}

const HANDLERS: RpcMethodHandlerMap<ExecRpcCtx> = {
  // The I33 chokepoint's only transport. Everything crossing this boundary is `unknown` until
  // validated -- no casts on `params`.
  "exec.run": async (params, ctx) => {
    const rec = asRecord(params) ?? {};
    // `cwd` is REQUIRED, never defaulted: the gateway's working directory is not the caller's, so
    // a default would run the child somewhere the caller never named.
    const cwd = requireString(params, "cwd");
    const req: RunExecutionRequest = {
      ...(typeof rec["code"] === "string" ? { code: rec["code"] } : {}),
      ...(typeof rec["filePath"] === "string" ? { filePath: rec["filePath"] } : {}),
      ...(typeof rec["runtimeId"] === "string" ? { runtimeId: rec["runtimeId"] } : {}),
      // All or nothing: a mixed array is an EMPTY grant list, never the partial one its string
      // elements would make — a capability set nobody chose.
      fsRead: stringArrayAllOrNothing(rec["fsRead"]),
      fsWrite: stringArrayAllOrNothing(rec["fsWrite"]),
      // Forwarded ONLY so the gate can refuse it. Omitting the key when absent keeps "asked for
      // nothing" distinct from "asked for an empty list".
      ...(rec["network"] === undefined ? {} : { network: stringArrayAllOrNothing(rec["network"]) }),
      ...(typeof rec["timeoutMs"] === "number" ? { timeoutMs: rec["timeoutMs"] } : {}),
      cwd,
    };
    return runExecution(req, ctx.gateDeps);
  },

  "exec.approvalRespond": (params, ctx) => {
    const requestId = requireString(params, "requestId");
    // Strict `=== true`: a missing or malformed field must read as denial, never approval.
    const approved = asRecord(params)?.["approved"] === true;
    return { matched: ctx.consent.respond(requestId, approved) };
  },
};

export function dispatchExecRpc(
  method: string,
  params: unknown,
  ctx: ExecRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
