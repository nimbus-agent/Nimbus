import type { PremortemPassResult } from "../premortem/premortem-pass.ts";
import { PremortemRefresherError } from "../premortem/premortem-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class PremortemRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "PremortemRpcError";
    this.rpcCode = rpcCode;
  }
}

export type PremortemRpcContext = {
  /** Absent when `[premortem].enabled = false` — the pass was never constructed. */
  premortemRefresher?: { runNow: () => Promise<PremortemPassResult> } | undefined;
};

/**
 * True when `params` is anything other than "no parameters supplied" (absent,
 * `null`, or an empty object/array). A non-empty object, a non-empty array,
 * or any other JSON value (string/number/boolean) all count as "the caller
 * supplied something" — `premortem.refresh` takes none, so any of those must
 * be rejected rather than silently ignored.
 */
function hasParams(params: unknown): boolean {
  if (params === null || params === undefined) return false;
  if (Array.isArray(params)) return params.length > 0;
  if (typeof params === "object") return Object.keys(params as Record<string, unknown>).length > 0;
  return true;
}

/**
 * Takes NO parameters and has no `rebuild` counterpart, following
 * `ownership.refresh`: the pass owns every row in its tables and re-derives
 * them from the index, so "rebuild" would be a synonym for refresh.
 */
async function handleRefresh(
  params: unknown,
  ctx: PremortemRpcContext,
): Promise<PremortemPassResult> {
  if (hasParams(params)) {
    throw new PremortemRpcError(-32602, "premortem.refresh takes no parameters");
  }
  if (ctx.premortemRefresher === undefined) {
    // Explicit failure, not a silent no-op: a resolved-looking success here
    // would tell the caller their themes were refreshed when the subsystem
    // is switched off entirely ([premortem].enabled = false).
    throw new PremortemRpcError(
      -32000,
      "ERR_PREMORTEM_DISABLED: premortem theme extraction is disabled — set [premortem].enabled = true in nimbus.toml",
    );
  }
  try {
    return await ctx.premortemRefresher.runNow();
  } catch (err) {
    // `runNow()` carries a single-flight guard and can reject with
    // `PremortemRefresherError` (ERR_PREMORTEM_PASS_RUNNING / ERR_PREMORTEM_STOPPED). That
    // error already carries the right `rpcCode` (see its doc comment in premortem-refresh.ts)
    // — reuse it rather than inventing a new code, mirroring how every other `tryDispatchXxxRpc`
    // in ipc/server/dispatchers.ts maps its refresher's own error class.
    if (err instanceof PremortemRefresherError) {
      throw new PremortemRpcError(err.rpcCode, err.message);
    }
    throw err;
  }
}

export async function dispatchPremortemRpc(
  method: string,
  params: unknown,
  ctx: PremortemRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<PremortemRpcContext>(method, params, ctx, {
    "premortem.refresh": (p, c) => handleRefresh(p, c),
  });
}
