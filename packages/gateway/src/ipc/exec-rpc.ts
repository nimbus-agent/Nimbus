import { asRecord } from "../connectors/unknown-record.ts";
import type { ExecConsentBroker } from "../exec/exec-consent-broker.ts";
import { type ExecGateDeps, type RunExecutionRequest, runExecution } from "../exec/exec-gate.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

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

/**
 * Module-private, matching `share-rpc.ts:108`.
 *
 * There is no shared IPC validation module: `requireString` is redefined in nine files under
 * `ipc/` across three signatures. Consolidating them is a worthwhile cleanup but would put most of
 * this feature's diff in unrelated RPC modules, so it is deliberately left alone here.
 */
function requireString(params: unknown, key: string): string {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ExecRpcError(-32602, `ERR_INVALID_PARAMS: ${key} (non-empty string) required`);
  }
  return v;
}

/**
 * Every element must be a string; a non-array or a mixed array yields an EMPTY grant list, never a
 * partial one -- a half-parsed grant set is a grant the caller did not ask for, and silently
 * dropping the bad element would hand the child a capability set nobody chose.
 */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
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
      fsRead: stringArray(rec["fsRead"]),
      fsWrite: stringArray(rec["fsWrite"]),
      // Forwarded ONLY so the gate can refuse it. Omitting the key when absent keeps "asked for
      // nothing" distinct from "asked for an empty list".
      ...(rec["network"] === undefined ? {} : { network: stringArray(rec["network"]) }),
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
