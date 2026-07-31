import type { GlossaryRefresher } from "../glossary/glossary-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export type GlossaryRpcContext = {
  refresher: GlossaryRefresher;
  notify: (method: string, params: unknown) => void;
};

export class GlossaryRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "GlossaryRpcError";
    this.rpcCode = rpcCode;
  }
}

const registry = new LongRunningJobRegistry();

/**
 * A pass runs up to `max_new_terms_per_pass * consolidate_timeout_ms` — 12.5
 * minutes at defaults — so both methods are long-running jobs rather than
 * blocking calls, following the `index.reembed` precedent.
 *
 * The precondition is checked SYNCHRONOUSLY here rather than being left to
 * `runNow`'s own guards: a caller who gets `{ jobId }` back reasonably believes
 * a pass started, so "already running" has to surface as an RPC error, not as a
 * `passError` notification arriving afterwards. `status()` cannot go stale
 * between this check and `runNow`'s prologue — neither awaits.
 */
function startPass(ctx: GlossaryRpcContext, rebuild: boolean): { jobId: string } {
  const status = ctx.refresher.status();
  if (status === "disabled") {
    throw new GlossaryRpcError(
      -32000,
      "ERR_GLOSSARY_DISABLED: the glossary is disabled — set [glossary].enabled = true in nimbus.toml",
    );
  }
  if (status === "stopped") {
    throw new GlossaryRpcError(-32000, "ERR_GLOSSARY_STOPPED: the gateway is shutting down");
  }
  if (status === "running") {
    throw new GlossaryRpcError(
      -32000,
      "ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running",
    );
  }
  return registry.start({
    jobIdPrefix: rebuild ? "glossary_rebuild" : "glossary_refresh",
    progressMethod: "glossary.passProgress",
    doneMethod: "glossary.passDone",
    errorMethod: "glossary.passError",
    emit: (m, payload) => {
      ctx.notify(m, payload);
    },
    // The refresher owns its own AbortSignal (aborted by `stop()` at shutdown),
    // so the registry's per-job signal is deliberately unused.
    run: (progress) =>
      ctx.refresher.runNow({
        rebuild,
        onProgress: (p) => {
          progress({ ...p });
        },
      }),
  });
}

export async function dispatchGlossaryRpc(
  method: string,
  params: unknown,
  ctx: GlossaryRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<GlossaryRpcContext>(method, params, ctx, {
    "glossary.refresh": (_p, c) => startPass(c, false),
    "glossary.rebuild": (_p, c) => startPass(c, true),
  });
}
