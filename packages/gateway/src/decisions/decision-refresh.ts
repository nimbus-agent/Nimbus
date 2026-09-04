import { createPassScheduler } from "../util/pass-scheduler.ts";
import type { DecisionPassSummary } from "./decision-extract.ts";

/** Carries `rpcCode` so a future `ipc/decisions-rpc.ts` maps it without re-deriving a code. */
export class DecisionRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "DecisionRefresherError";
    this.rpcCode = -32000;
  }
}

export type DecisionRunOptions = {
  /** Reserved for a future `rebuildDecisions` path; the debounced `trigger()` path never sets it. */
  rebuild?: boolean;
};

export type DecisionRefresherDeps = {
  debounceMs: number;
  /** Injected rather than imported so the module is testable without a Database. */
  runPass: (opts?: DecisionRunOptions) => Promise<DecisionPassSummary>;
  onError?: (err: unknown) => void;
};

export type DecisionRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  /**
   * Runs a pass immediately, bypassing the debounce. Shares the single-flight
   * guard with the scheduled path: a scheduled pass and an on-demand pass must
   * never run concurrently, since both write `decision_record` and the pass
   * watermark.
   */
  run: (opts?: DecisionRunOptions) => Promise<DecisionPassSummary>;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the decision extraction pass. The debounce, the
 * single-flight guard and the dirty-rerun all live in `util/pass-scheduler.ts`, shared with the
 * glossary, ownership and pre-mortem passes — this module supplies only what is specific to
 * decisions: the summary type, the `ERR_DECISIONS_*` codes, and the pass itself.
 *
 * LIMIT — `stop()` is not cancellation. It clears the debounce timer and refuses every later
 * run; a pass already awaiting `provider.generate` runs to completion, and there is no timeout
 * beneath it. A hung local model therefore pins the scheduler `running` for the life of the
 * process, and every later `run()` throws `ERR_DECISIONS_PASS_RUNNING` until the gateway
 * restarts — which is the documented recovery (`docs/cli-reference.md`, `nimbus decisions`).
 *
 * The scheduler's `AbortSignal` does NOT fix that, which is why this module discards it: the
 * abort has nowhere to go, because `LlmGenerateOptions` carries no `signal` field. The fix is
 * that cross-cutting LLM-layer change, which glossary needs identically — see the LIMIT notes in
 * `decisions/decision-llm-adapter.ts` and `glossary/glossary-llm-adapter.ts`. Do it there first,
 * then let this pass read the signal it is already handed.
 */
export function createDecisionRefresher(deps: DecisionRefresherDeps): DecisionRefresher {
  const scheduler = createPassScheduler<DecisionPassSummary, DecisionRunOptions | undefined>({
    debounceMs: deps.debounceMs,
    // The signal is accepted and DISCARDED — see the LIMIT note above: this pass has nowhere to
    // route an abort, because `LlmGenerateOptions` carries no `signal` field.
    runPass: (_signal, opts) => deps.runPass(opts),
    scheduledOptions: undefined,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    refuse: (kind) =>
      new DecisionRefresherError(
        kind === "running"
          ? "ERR_DECISIONS_PASS_RUNNING: a decisions pass is already running"
          : "ERR_DECISIONS_STOPPED: the gateway is shutting down",
      ),
  });

  return {
    trigger: scheduler.trigger,
    run: (opts?: DecisionRunOptions) => scheduler.runNow(opts),
    stop: scheduler.stop,
  };
}
