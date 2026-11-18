/**
 * `iac.*` - the owner's Terraform drift check (Phase 10 IaC drift D2, owner ruling OR-DRIFT-1).
 *
 *   - `iac.driftCheck { workdir? }` runs the read-only check now for one approved workdir (its exact
 *     stored spelling) or each in turn, and returns the findings (`{ findings }`).
 *   - `iac.driftLatest` returns the stored latest finding per workdir (`{ findings }`).
 *
 * CLI ONLY: answered only to a connection that declared `cli` (the dispatcher passes the CONNECTION's
 * kind, never a param), so never the desktop, an MCP agent, ChatOps, HTTP or a fleet peer. The whole
 * `iac` namespace is LAN-forbidden (I5, `ipc/lan-rpc.ts`, a DENYLIST) and absent from the Tauri
 * allowlist (I7). No runner is bound on a demo gateway (I41): both methods then refuse.
 */

import type { DriftFinding } from "../iac-drift/drift-findings.ts";
import { IacDriftNotApprovedError, type IacDriftRunner } from "../iac-drift/drift-runner.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ClientKind } from "./server/client-kind.ts";

export class IacDriftRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const IAC_DRIFT_CLI_ONLY =
  "ERR_IAC_DRIFT_CLI_ONLY: the drift check is available only to the owner's CLI on the local socket";
export const IAC_DRIFT_UNAVAILABLE =
  "ERR_IAC_DRIFT_UNAVAILABLE: the drift check is not available on this gateway";
export const IAC_DRIFT_BAD_PARAMS = "ERR_IAC_DRIFT_BAD_PARAMS: workdir must be a non-empty string";

export interface IacDriftRpcCtx {
  /** Absent on a demo gateway (I41) and until `gateway-main.ts` binds it. */
  readonly runner: () => IacDriftRunner | undefined;
}

function runnerOf(ctx: IacDriftRpcCtx, kind: ClientKind): IacDriftRunner {
  if (kind !== "cli") throw new IacDriftRpcError(-32000, IAC_DRIFT_CLI_ONLY);
  const runner = ctx.runner();
  if (runner === undefined) throw new IacDriftRpcError(-32000, IAC_DRIFT_UNAVAILABLE);
  return runner;
}

function workdirParam(params: unknown): string | undefined {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new IacDriftRpcError(-32602, IAC_DRIFT_BAD_PARAMS);
  }
  const w = (params as Record<string, unknown>)["workdir"];
  if (w === undefined) return undefined;
  if (typeof w !== "string" || w === "") throw new IacDriftRpcError(-32602, IAC_DRIFT_BAD_PARAMS);
  return w;
}

export async function dispatchIacDriftRpc(
  method: string,
  params: unknown,
  ctx: IacDriftRpcCtx,
  caller: { readonly kind: ClientKind },
): Promise<RpcMissOrHit<{ findings: DriftFinding[] }>> {
  return dispatchByMethod<IacDriftRpcCtx, { findings: DriftFinding[] }>(method, params, ctx, {
    "iac.driftCheck": async (p, c) => {
      const runner = runnerOf(c, caller.kind);
      const workdir = workdirParam(p);
      try {
        const findings = await runner.check({
          ...(workdir === undefined ? {} : { workdir }),
          startedBy: "owner_cli",
        });
        return { findings };
      } catch (e) {
        if (e instanceof IacDriftNotApprovedError) throw new IacDriftRpcError(-32000, e.message);
        throw e;
      }
    },
    "iac.driftLatest": (_p, c) => ({ findings: runnerOf(c, caller.kind).latest() }),
  });
}
