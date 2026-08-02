import type { DecisionRefresher } from "../decisions/decision-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export type DecisionsRpcContext = {
  refresher: DecisionRefresher;
  notify: (method: string, params: unknown) => void;
};

export class DecisionsRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "DecisionsRpcError";
    this.rpcCode = rpcCode;
  }
}

const registry = new LongRunningJobRegistry();

/**
 * Mirrors `ipc/glossary-rpc.ts`, but `DecisionRefresher` (decisions/decision-refresh.ts)
 * is a smaller surface than `GlossaryRefresher`: it exposes only `trigger()` / `run()` /
 * `stop()` — no `status()` probe, and `run()`'s only option is `{ rebuild? }` (no
 * `onProgress`). Two consequences, deliberate rather than oversights:
 *
 * 1. No "disabled" precondition to check here: unlike `glossaryRefresher` (always
 *    constructed, internally gated), `decisionsRefresher` is constructed at all only when
 *    `[decisions].enabled` (see `ipc/server/options.ts`), so an absent refresher already
 *    surfaces as "Method not found" one level up in the dispatcher — there is no
 *    ERR_DECISIONS_DISABLED to throw.
 * 2. No synchronous "already running" / "shutting down" precondition check before
 *    `registry.start()`, unlike glossary's `startPass`. `DecisionRefresher.run()` enforces
 *    those guards internally and rejects with a `DecisionRefresherError` (carrying
 *    `rpcCode -32000`) when they fire — but since `run()` is async, that rejection cannot be
 *    observed synchronously here. It is instead caught by the job registry and surfaces as a
 *    `decisions.passError` notification: a caller that gets `{ jobId }` back may see an
 *    immediate `passError` for "already running", rather than never receiving a jobId at all
 *    as with glossary. Giving `DecisionRefresher` a synchronous status probe to close this gap
 *    is out of scope for this RPC layer.
 */
function startPass(ctx: DecisionsRpcContext, rebuild: boolean): { jobId: string } {
  return registry.start({
    jobIdPrefix: rebuild ? "decisions_rebuild" : "decisions_refresh",
    progressMethod: "decisions.passProgress",
    doneMethod: "decisions.passDone",
    errorMethod: "decisions.passError",
    emit: (m, payload) => {
      ctx.notify(m, payload);
    },
    // `DecisionRunOptions` carries no `onProgress` hook (unlike glossary's `runNow`), so the
    // registry's progress callback has nothing to relay — a decisions pass currently reports
    // no mid-pass progress. `rebuild` is the only value threaded through, and it is fixed by
    // which method was called: `decisions.refresh` always passes `false`, `decisions.rebuild`
    // always passes `true` — the two methods never share a code path that could let `refresh`
    // clear anything.
    run: () => ctx.refresher.run({ rebuild }),
  });
}

export async function dispatchDecisionsRpc(
  method: string,
  params: unknown,
  ctx: DecisionsRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<DecisionsRpcContext>(method, params, ctx, {
    "decisions.refresh": (_p, c) => startPass(c, false),
    "decisions.rebuild": (_p, c) => startPass(c, true),
  });
}
