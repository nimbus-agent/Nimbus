import type { OwnershipRefresher } from "../ownership/ownership-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export type OwnershipRpcContext = {
  refresher: OwnershipRefresher;
  notify: (method: string, params: unknown) => void;
};

const registry = new LongRunningJobRegistry();

/**
 * Mirrors `ipc/decisions-rpc.ts`. Three deliberate absences:
 *
 * 1. No "disabled" precondition. `ownershipRefresher` is constructed at all only when
 *    `[ownership].enabled` (`platform/assemble.ts`), so an absent refresher already
 *    surfaces as "Method not found" in `tryDispatchOwnershipRpc`.
 * 2. No `rebuild` verb. The ownership pass clears and re-emits WHOLESALE every run, so a
 *    rebuild would be a synonym for refresh — shipping both would imply a difference that
 *    does not exist.
 * 3. No `<X>RpcError` class. Glossary/decisions each remap a synchronous precondition
 *    failure (an in-flight-pass or disabled check) to an RPC error code. `startPass` has no
 *    such precondition — the sole handler always returns `{ jobId }` synchronously, so
 *    there is nothing here that ever throws before returning "hit" or "miss".
 *
 * The method takes NO parameters, and that is a safety property rather than tidiness:
 * `runOwnershipPass` clears every `person --owns--> service` edge each pass and re-emits
 * only what is reachable from `opts.roots`, so a caller-supplied root list or filter would
 * ERASE the ownership of every service the omitted roots bind — and report success.
 */
function startPass(ctx: OwnershipRpcContext): { jobId: string } {
  return registry.start({
    jobIdPrefix: "ownership_refresh",
    progressMethod: "ownership.passProgress",
    doneMethod: "ownership.passDone",
    errorMethod: "ownership.passError",
    emit: (m, payload) => {
      ctx.notify(m, payload);
    },
    run: () => ctx.refresher.run(),
  });
}

export async function dispatchOwnershipRpc(
  method: string,
  params: unknown,
  ctx: OwnershipRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<OwnershipRpcContext>(method, params, ctx, {
    "ownership.refresh": (_p, c) => startPass(c),
  });
}
